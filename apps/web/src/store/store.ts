import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import type {
  Action,
  AppState,
  Author,
  Effect,
  ListeningState,
  LlmResponse,
  ScrollState,
  Settings,
  SfxSound,
  SttProvider,
  Usage,
  Version,
} from "@yammer/shared";
import type { Sfx } from "../voice/interfaces";
import { initialState } from "@yammer/shared";
import {
  applyAction,
  applyTurn,
  assembleContext,
  parseLlmResponse,
} from "@yammer/core";
import type { Ctx } from "@yammer/core";
import type { ApiClient, PersistUndo } from "../api/client";
import { copyToClipboard, downloadFile, playSfx } from "./browser-effects";

// The Zustand store is the edge: it holds AppState, drives the pure reducer with
// validated actions, and carries out the Effect[] the reducer returns (persist,
// load, research, scroll, clipboard, download, SFX). The UI is a pure function
// of `app`. Voice/LLM/network are injected (ApiClient, SttProvider) so the whole
// store is testable with mocks and never touches a real API.

export type SttPhase = "idle" | "finalizing" | "sending";

/** A turn (request + valid response) gets this many attempts before we give up and
 * surface an error -- covers a transient upstream 502 and the occasional unusable
 * model response, both of which usually succeed on a retry. */
const MAX_TURN_ATTEMPTS = 3;
/** Linear backoff base between turn retries (multiplied by the attempt number). */
const TURN_RETRY_DELAY_MS = 400;
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** One-shot scroll command forwarded to a panel; the nonce makes repeats fire. */
export interface ScrollCommand {
  target: "document" | "chat";
  direction: "up" | "down";
  amount: "line" | "page";
  nonce: number;
}

export interface AppStore {
  app: AppState;
  /** Per-document turn usages; the spend meter sums these. Reset on doc switch. */
  usages: Usage[];
  /** True while the mic detects speech (drives the pulse indicator). */
  vadActive: boolean;
  /** Smoothed mic input level, 0..1, updated ~30x/s while listening. Drives the
   * amplitude-reactive size/glow of the mic button so the user can see it hearing
   * them. 0 when not listening. */
  micLevel: number;
  /** Live partial transcript ("what you're saying now"), shown as gray text in the
   * composer until the utterance is submitted as a message. Empty when not
   * mid-utterance. */
  interimTranscript: string;
  sttPhase: SttPhase;
  /** Machine-derived: "finalizing" while an utterance is finalizing or in the
   * pre-send grace window (drives the radial). Distinct from `sttPhase`, which
   * the turn loop owns for the LLM "sending" phase. */
  listeningPhase: "idle" | "finalizing";
  /** Whether the tap-to-start gate has been dismissed and the mic granted. An
   * edge/session flag, not persisted domain state. Only set true once capture is
   * CONFIRMED, so the gate never dismisses on an optimistic (unconfirmed) start. */
  micStarted: boolean;
  /** Whether the voice pipeline (the late-bound dynamic import) is wired and ready
   * to accept a start. An early tap before this is true is queued, not lost. */
  voiceReady: boolean;
  /** True while a tap-to-start is queued waiting on `voiceReady` (drives the gate
   * button's busy/label state). */
  startQueued: boolean;
  lastError: string | null;
  scrollCommand: ScrollCommand | null;

  /** Tap-to-start gate: dismiss the gate and begin listening. Must run inside a
   * user gesture so the mic-permission request is allowed by the browser. If the
   * voice pipeline is not yet ready the tap is queued and runs on ready. */
  startMic: () => void;
  /** Mark the (late-bound) voice pipeline ready; runs any queued tap-to-start. */
  setVoiceReady: (ready: boolean) => void;
  /** Push a voice-pipeline error (STT/mic/reconnect/finalize) into the chat error
   * log so it is shown and announced (role=status/aria-live). The public
   * voice-error channel the voice pipeline routes its failures through. */
  pushVoiceError: (message: string) => void;
  /** Push the voice pipeline's derived indicator signals into the view. */
  setVoiceIndicator: (indicator: { vad: boolean; finalizing: boolean }) => void;
  /** Push the current smoothed mic input level (0..1) into the view. */
  setMicLevel: (level: number) => void;
  /** Push the live partial transcript into the composer (gray preview text). */
  setInterim: (text: string) => void;
  /** Submit typed composer text as a turn (the keyboard path; STT uses the same
   * submitTranscript under the hood). Clears any interim preview. */
  submitComposerText: (text: string) => void;
  /** Apply one action from a UI control (default author "user"). */
  dispatch: (action: Action, author?: Author) => void;
  /** Update one or more settings from the Settings dialog: merge into
   * app.settings (applied immediately -- e.g. theme via useTheme) and persist via
   * the persist_settings effect. Not routed through the reducer/Action protocol
   * because settings are edge/user-preference state, not an LLM-emitted action. */
  updateSettings: (patch: Partial<Settings>) => void;
  /** Apply a validated LLM turn (author "ai") and record its usage. */
  applyResponse: (response: LlmResponse, usage?: Usage) => void;
  /** Send a finished transcript through the turn loop (append user message,
   * call the LLM, validate, apply, record usage). `sttSeconds` is the utterance's
   * audio length, folded into the turn usage server-side for the spend meter. */
  submitTranscript: (text: string, sttSeconds?: number) => Promise<void>;
  setDocumentScroll: (scroll: ScrollState) => void;
  setChatScroll: (scroll: ScrollState) => void;
  /** Live text sync from direct keyboard editing (no version -- a dev
   * convenience; AI/voice edits are the ones that append to history). */
  setDocumentText: (text: string) => void;
  /** Resolves when the serial version-persist queue has drained (or paused on a
   * surfaced error). Primarily a test hook -- persistence is fire-and-await in
   * the background, and this lets callers wait for it deterministically. */
  flushPersistQueue: () => Promise<void>;
}

export interface StoreDeps {
  api: ApiClient;
  stt: SttProvider;
  now?: () => string;
  newId?: () => string;
  initial?: Partial<AppState>;
  /** Backoff before retrying a failed persist (ms), by 0-based attempt index.
   * Overridable so tests can drop the delays. */
  retryDelayMs?: (attempt: number) => number;
  /** Sound-effect sink for the play_sfx effect. When omitted we fall back to the
   * built-in browser-effects tone (keeps the store usable with no voice wiring). */
  sfx?: Sfx;
  /** Routes the set_listening effect to the voice pipeline's listening machine.
   * When omitted the store just drives the injected SttProvider (Phase 3). */
  onSetListening?: (state: ListeningState) => void;
  /** Confirmed-capture tap-to-start: resolves once the mic is actually live and
   * rejects on a permission denial. When provided, startMic waits for it before
   * entering the listening state (so a denial never shows a lying "Listening").
   * When omitted the store falls back to the optimistic Phase-3 behavior. */
  startCapture?: () => Promise<void>;
  /** Whether the voice pipeline is ready at construction. The real app defers it
   * (false) until the dynamic voice import resolves; tests/mocks default ready. */
  voiceReady?: boolean;
  /** Delay before re-attempting a persist drain that paused on exhausted retries
   * (ms). Overridable so tests can drop the wait. */
  reDrainDelayMs?: number;
}

export function createAppStore(deps: StoreDeps): StoreApi<AppStore> {
  let idCounter = 0;
  const newId = deps.newId ?? (() => `id-${++idCounter}`);
  const now = deps.now ?? (() => new Date().toISOString());
  let scrollNonce = 0;
  /** A tap-to-start that arrived before the voice pipeline was ready; run on
   * setVoiceReady(true) so an early tap is never a lost no-op. */
  let queuedStart = false;

  const MAX_PERSIST_TRIES = 3;
  const retryDelayMs = deps.retryDelayMs ?? ((attempt) => 200 * 2 ** attempt);
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const errMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  /** Numeric HTTP status if the error carries one (ApiError does), else undefined. */
  function httpStatus(err: unknown): number | undefined {
    if (typeof err === "object" && err !== null && "status" in err) {
      const s = (err as { status?: unknown }).status;
      if (typeof s === "number") return s;
    }
    return undefined;
  }

  const store = createStore<AppStore>((set, get) => {
    const ctxFor = (author: Author): Ctx => ({ newId, now, author });

    function pushEntry(entry: AppState["chat"][number]): void {
      set((s) => ({ app: { ...s.app, chat: [...s.app.chat, entry] } }));
    }

    /** Surface a failure loudly: an error entry in the chat log + lastError.
     * Nothing in the store should ever swallow a rejection -- a dropped edit is
     * the worst failure for a voice user, so every path funnels through here. */
    function surfaceError(message: string): void {
      pushEntry({ kind: "error", id: newId(), at: now(), message });
      set({ lastError: message });
    }

    /** Run a fire-and-forget async effect, surfacing any rejection instead of
     * letting it vanish into an unhandled promise. */
    function runGuarded(label: string, work: () => Promise<void>): void {
      void work().catch((err) => {
        surfaceError(`${label} failed: ${errMessage(err)}`);
      });
    }

    // -- Durable, ordered version persistence -------------------------------
    // Versions persist through a serial FIFO queue: one in-flight write at a
    // time, drained strictly in order so the server's seq never sees a gap. A
    // transient failure retries with backoff and then surfaces (never drops) the
    // edit; a 409 seq-conflict means another device advanced the head, so we
    // reload the authoritative document and tell the user.

    interface PersistItem {
      version: Version;
      undo: PersistUndo;
    }
    const persistQueue: PersistItem[] = [];
    let draining = false;
    let drainPromise: Promise<void> = Promise.resolve();
    let reDrainHandle: ReturnType<typeof setTimeout> | null = null;
    const reDrainDelayMs = deps.reDrainDelayMs ?? 5000;
    // Consecutive re-drain failures, for exponential backoff, and a latch so a
    // stuck save surfaces ONE error, not a fresh chat entry on every retry. Both
    // reset the moment any version persists (connectivity is back).
    let reDrainAttempts = 0;
    let persistErrorSurfaced = false;
    /** Cap on the backoff so we keep retrying forever but at most once a minute --
     * never dropping the edit, never spamming. */
    const RE_DRAIN_MAX_MS = 60_000;

    /** Start draining if there is queued work and no drain is in flight. Safe to
     * call from anywhere (enqueue, the re-drain timer, the `online` event). */
    function kickDrain(): void {
      if (draining || persistQueue.length === 0) return;
      draining = true;
      drainPromise = drainPersistQueue().finally(() => {
        draining = false;
      });
    }

    /** After retries are exhausted the head item stays queued but nothing is
     * in flight, so schedule a delayed retry -- otherwise the last edit may never
     * persist unless the user makes another edit. Coalesced to one pending timer;
     * the `online` event resumes immediately (below). */
    function scheduleReDrain(): void {
      if (reDrainHandle !== null || persistQueue.length === 0) return;
      // Exponential backoff, capped: 5s, 10s, 20s, 40s, then 60s forever. Keeps
      // retrying indefinitely (the edit is never dropped) without hammering a down
      // server or flooding the log.
      const backoff = Math.min(
        RE_DRAIN_MAX_MS,
        reDrainDelayMs * 2 ** reDrainAttempts,
      );
      reDrainAttempts += 1;
      reDrainHandle = setTimeout(() => {
        reDrainHandle = null;
        kickDrain();
      }, backoff);
    }

    function enqueuePersist(version: Version, undo: PersistUndo): void {
      persistQueue.push({ version, undo });
      kickDrain();
    }

    // Resume a paused persist queue the instant connectivity returns, so an edit
    // stranded by an offline blip persists without waiting on the re-drain timer
    // or another user action.
    if (
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ) {
      window.addEventListener("online", () => kickDrain());
    }

    async function attemptPersist(
      item: PersistItem,
    ): Promise<"ok" | "conflict" | "failed"> {
      for (let attempt = 0; attempt < MAX_PERSIST_TRIES; attempt++) {
        try {
          await deps.api.persistVersion(item.version, item.undo);
          return "ok";
        } catch (err) {
          if (httpStatus(err) === 409) return "conflict";
          if (attempt < MAX_PERSIST_TRIES - 1) await delay(retryDelayMs(attempt));
        }
      }
      return "failed";
    }

    async function drainPersistQueue(): Promise<void> {
      while (persistQueue.length > 0) {
        const item = persistQueue[0]!;
        const outcome = await attemptPersist(item);
        if (outcome === "ok") {
          persistQueue.shift();
          // A successful write means we're connected again: clear the backoff and
          // re-arm the one-shot error latch so a LATER outage surfaces once more.
          reDrainAttempts = 0;
          persistErrorSurfaced = false;
          continue;
        }
        if (outcome === "conflict") {
          // The server head advanced elsewhere for THIS document. Only edits for
          // the conflicting document are built on a now-stale base -- drop just
          // those and reconcile; pending edits for other documents the user
          // switched away from must not be silently dropped.
          const conflictedDoc = item.version.documentId;
          for (let i = persistQueue.length - 1; i >= 0; i--) {
            if (persistQueue[i]!.version.documentId === conflictedDoc) {
              persistQueue.splice(i, 1);
            }
          }
          await reconcile(conflictedDoc);
          continue; // keep draining any surviving other-document edits
        }
        // Transient failure survived every retry. PAUSE at the head (never drop
        // the edit) and schedule a backed-off re-drain (and the `online` event
        // resumes immediately) so the edit is retried even without another user
        // action. Ordering and the user's work are preserved. Surface the problem
        // ONCE per outage -- the latch stops a fresh chat error on every retry.
        if (!persistErrorSurfaced) {
          persistErrorSurfaced = true;
          surfaceError(
            `Could not save your last edit to the server (attempted ${MAX_PERSIST_TRIES} times). Your work is kept and will keep retrying in the background -- please check your connection.`,
          );
        }
        scheduleReDrain();
        return;
      }
    }

    /** Reload the authoritative document + history after a seq-conflict and
     * rebuild the undo timeline from the server, telling the user it changed. */
    async function reconcile(documentId: string): Promise<void> {
      try {
        const payload = await deps.api.getDocument(documentId);
        set((s) => ({
          app: {
            ...s.app,
            activeDocument: payload.document,
            history: payload.history,
            undoStack: payload.history.map((v) => v.id),
            undoCursor: payload.history.length - 1,
          },
        }));
        pushEntry({
          kind: "error",
          id: newId(),
          at: now(),
          message:
            "This document changed on another device, so your last edit could not be saved. It has been reloaded from the server -- please re-apply your change.",
        });
        set({ lastError: "Document changed elsewhere; reloaded from the server." });
      } catch (err) {
        surfaceError(
          `Reloading the document after a sync conflict failed: ${errMessage(err)}`,
        );
      }
    }

    function sfx(sound: SfxSound): void {
      if (!get().app.settings.sfxEnabled) return;
      if (deps.sfx) deps.sfx.play(sound);
      else playSfx(sound);
    }

    async function handleCreateDocument(name?: string): Promise<void> {
      // Creation is the one server-authoritative mint: the server assigns the
      // canonical id + ownership and commits the seq-0 create version atomically,
      // returning the document + history to adopt as the base. Later edits are
      // client-authoritative versions persisted through the queue.
      //
      // (The previous path minted a LOCAL version 0 and enqueued it to a document
      // the server had never created -> a permanent 404 that the persist queue
      // retried forever, spamming the chat. See the third-browser-test backlog.)
      const payload = await deps.api.createDocument(name);
      set((s) => ({
        app: {
          ...s.app,
          activeDocument: payload.document,
          history: payload.history,
          undoStack: payload.history.map((v) => v.id),
          undoCursor: payload.history.length - 1,
          openDialog: null,
        },
        usages: [],
      }));
      // A visible boundary in the transcript: the chat is retained across documents,
      // so mark which document the following messages belong to.
      pushEntry({
        kind: "document",
        id: newId(),
        at: now(),
        event: "created",
        name: payload.document.name,
      });
    }

    async function handleLoadDocument(e: {
      documentId?: string;
      byName?: string;
      byDate?: string;
    }): Promise<void> {
      const payload = await deps.api.getDocument(e.documentId, e.byName, e.byDate);
      set((s) => ({
        app: {
          ...s.app,
          activeDocument: payload.document,
          history: payload.history,
          undoStack: payload.history.map((v) => v.id),
          undoCursor: payload.history.length - 1,
          openDialog: null,
        },
        usages: [],
      }));
      pushEntry({
        kind: "document",
        id: newId(),
        at: now(),
        event: "opened",
        name: payload.document.name,
      });
    }

    async function handleLoadDocuments(sort: AppState["settings"]["loadDocSort"]): Promise<void> {
      const documents = await deps.api.listDocuments(sort);
      set((s) => ({ app: { ...s.app, documents } }));
    }

    async function handleResearch(queries: string[]): Promise<void> {
      // The reducer already pushed "Searching the web…" when the research action
      // ran; stage the next status before the (single) server round-trip that
      // reads + digests, then land the digested note as a research entry. Its
      // billed usage is folded into the spend meter exactly like a turn's usage.
      pushEntry({ kind: "thinking", id: newId(), at: now(), status: "Reading results…" });
      const { note, usage } = await deps.api.research(queries);
      pushEntry({ kind: "research", id: newId(), at: now(), summary: note });
      set((s) => ({ usages: [...s.usages, usage] }));
    }

    async function handleExport(
      documentId: string,
      format: "md" | "docx",
    ): Promise<void> {
      const doc = get().app.activeDocument;
      if (!doc || doc.id !== documentId) return;
      const safeName = doc.name.replace(/[^\w.-]+/g, "_") || "document";
      if (format === "md") {
        downloadFile(`${safeName}.md`, doc.text, "text/markdown");
        return;
      }
      const blob = await deps.api.exportDocx(documentId);
      downloadFile(`${safeName}.docx`, blob, blob.type);
    }

    async function handleDiagnostics(documentId: string): Promise<void> {
      // GET the authoritative diagnostic log from the server (transcripts -> raw
      // LLM responses -> actions + full version history) and trigger a browser
      // file download. A failure surfaces through runGuarded into the chat/voice
      // error channel rather than silently dropping.
      const blob = await deps.api.getDiagnostics(documentId);
      const doc = get().app.activeDocument;
      const base =
        doc && doc.id === documentId
          ? doc.name.replace(/[^\w.-]+/g, "_") || "document"
          : "diagnostics";
      downloadFile(
        `${base}-diagnostics.json`,
        blob,
        blob.type || "application/json",
      );
    }

    function applyListening(state: AppState["listening"]): void {
      // Prefer the voice pipeline's listening machine when wired; otherwise drive
      // the injected SttProvider directly (Phase 3 / test path).
      if (deps.onSetListening) deps.onSetListening(state);
      else if (state === "listening") deps.stt.start();
      else deps.stt.stop();
      if (state !== "listening") {
        // Not listening: the STT mic is stopped, so no more level updates arrive --
        // zero it now so the button rests at its normal size instead of frozen.
        set({
          vadActive: false,
          micLevel: 0,
          interimTranscript: "",
          sttPhase: "idle",
          listeningPhase: "idle",
        });
      }
    }

    function runEffects(effects: Effect[]): void {
      for (const effect of effects) {
        switch (effect.type) {
          case "persist_version": {
            // Persist the resulting version AND the current undo timeline (N3),
            // read after the reducer's state was committed above.
            const { undoStack, undoCursor } = get().app;
            enqueuePersist(effect.version, { undoStack, undoCursor });
            break;
          }
          case "create_document":
            runGuarded("Creating the document", () =>
              handleCreateDocument(effect.name),
            );
            break;
          case "load_document":
            runGuarded("Loading the document", () => handleLoadDocument(effect));
            break;
          case "load_documents":
            runGuarded("Loading the document list", () =>
              handleLoadDocuments(effect.sort),
            );
            break;
          case "rename_document":
            runGuarded("Renaming the document", () =>
              deps.api.renameDocument(effect.documentId, effect.name),
            );
            break;
          case "run_research":
            runGuarded("Research", () => handleResearch(effect.queries));
            break;
          case "scroll_to":
            set({
              scrollCommand: {
                target: effect.target,
                direction: effect.direction,
                amount: effect.amount,
                nonce: ++scrollNonce,
              },
            });
            break;
          case "set_listening":
            applyListening(effect.state);
            break;
          case "copy_to_clipboard":
            runGuarded("Copying to the clipboard", () =>
              copyToClipboard(effect.text),
            );
            break;
          case "export_document":
            runGuarded("Exporting the document", () =>
              handleExport(effect.documentId, effect.format),
            );
            break;
          case "play_sfx":
            sfx(effect.sound);
            break;
          case "persist_settings":
            runGuarded("Saving your settings", () =>
              deps.api.persistSettings(effect.settings),
            );
            break;
          case "download_diagnostics":
            runGuarded("Downloading the diagnostic log", () =>
              handleDiagnostics(effect.documentId),
            );
            break;
        }
      }
    }

    function applyResponse(response: LlmResponse, usage?: Usage): void {
      const result = applyTurn(get().app, response, ctxFor("ai"));
      set((s) => ({
        app: result.state,
        usages: usage ? [...s.usages, usage] : s.usages,
        lastError: result.error ?? null,
      }));
      runEffects(result.effects);
    }

    // -- Serialized voice turns --------------------------------------------
    // Utterances run through a FIFO queue, one turn fully committed before the
    // next starts. Two quickly-finalized utterances must not race: each turn
    // re-assembles SituationalContext against the LATEST committed state, so the
    // second turn sees the first turn's edits instead of a stale snapshot.

    interface QueuedTurn {
      text: string;
      sttSeconds?: number;
      resolve: () => void;
    }
    const turnQueue: QueuedTurn[] = [];
    let processingTurns = false;

    function enqueueTurn(text: string, sttSeconds?: number): Promise<void> {
      return new Promise<void>((resolve) => {
        turnQueue.push({ text, sttSeconds, resolve });
        if (!processingTurns) {
          processingTurns = true;
          void processTurnQueue();
        }
      });
    }

    async function processTurnQueue(): Promise<void> {
      try {
        while (turnQueue.length > 0) {
          const item = turnQueue[0]!;
          try {
            await runTurn(item.text, item.sttSeconds);
          } finally {
            turnQueue.shift();
            item.resolve();
          }
        }
      } finally {
        processingTurns = false;
      }
    }

    /** Run a single turn. sttPhase is reset in a `finally` no matter what fails
     * -- the store is a module singleton, so a stuck "sending" would freeze the
     * mic forever. A non-EditError throw (EditErrors are handled in-core as error
     * entries) is surfaced rather than swallowed. */
    async function runTurn(text: string, sttSeconds?: number): Promise<void> {
      set((s) => ({
        app: {
          ...s.app,
          chat: [
            ...s.app.chat,
            { kind: "user_message", id: newId(), at: now(), text },
          ],
        },
        // The utterance is now a message bubble; clear the live preview.
        interimTranscript: "",
        sttPhase: "sending",
      }));

      try {
        const context = assembleContext(get().app);
        const documentId = get().app.activeDocument?.id;

        // A turn can fail two ways -- the request itself (network / 502 upstream) or
        // an invalid model response -- and BOTH warrant a couple of retries: a
        // UI-driving AI that emits an unusable turn is UI-breaking, so we retry
        // before surfacing, and on final failure we log the FULL raw response so the
        // bug is diagnosable rather than a bare "expected string, received null".
        for (let attempt = 1; attempt <= MAX_TURN_ATTEMPTS; attempt++) {
          const last = attempt >= MAX_TURN_ATTEMPTS;
          let result;
          try {
            result = await deps.api.turn({
              transcript: text,
              context,
              ...(documentId !== undefined ? { documentId } : {}),
              ...(sttSeconds !== undefined ? { sttSeconds } : {}),
            });
          } catch (err) {
            if (!last) {
              await delay(TURN_RETRY_DELAY_MS * attempt);
              continue;
            }
            surfaceError(`Turn request failed after ${attempt} attempts: ${errMessage(err)}`);
            return;
          }

          const parsed = parseLlmResponse({
            chatMessage: result.chatMessage,
            actions: result.actions,
          });
          if (parsed.ok) {
            applyResponse(parsed.response, result.usage);
            return;
          }

          // Invalid response: it was still billed, so record usage; log the raw
          // envelope (console -- the model's actual output) for troubleshooting.
          set((s) => ({ usages: [...s.usages, result.usage], lastError: parsed.error }));
          // eslint-disable-next-line no-console
          console.error(
            `[turn] invalid LLM response (attempt ${attempt}/${MAX_TURN_ATTEMPTS}): ${parsed.error}`,
            { transcript: text, chatMessage: result.chatMessage, actions: result.actions, raw: result.raw },
          );
          if (!last) {
            await delay(TURN_RETRY_DELAY_MS * attempt);
            continue;
          }
          pushEntry({
            kind: "error",
            id: newId(),
            at: now(),
            message: `Invalid LLM response after ${attempt} attempts: ${parsed.error}. Full response logged to the browser console.`,
          });
          return;
        }
      } catch (err) {
        surfaceError(`Turn failed: ${errMessage(err)}`);
      } finally {
        set({ sttPhase: "idle" });
      }
    }

    return {
      app: initialState(deps.initial),
      usages: [],
      vadActive: false,
      micLevel: 0,
      interimTranscript: "",
      sttPhase: "idle",
      listeningPhase: "idle",
      micStarted: false,
      voiceReady: deps.voiceReady ?? true,
      startQueued: false,
      lastError: null,
      scrollCommand: null,

      startMic() {
        // The click IS the user gesture: create + resume the shared AudioContext
        // synchronously here (before any await), so iOS Safari does not leave it
        // suspended -- otherwise the first SFX is silent and the worklet dead.
        deps.sfx?.unlock();

        // Early-tap race: the voice pipeline is late-bound (dynamic import). If it
        // is not ready yet, remember the tap and run it on ready rather than
        // dropping it as a no-op.
        if (!get().voiceReady) {
          queuedStart = true;
          set({ startQueued: true });
          return;
        }

        if (!deps.startCapture) {
          // Phase-3 / no real capture seam: optimistic start (existing behavior).
          set({ micStarted: true, startQueued: false });
          get().dispatch({ type: "set_listening", state: "listening" });
          return;
        }

        // Confirmed-capture path: do NOT enter the listening state until the mic
        // is actually live. On a getUserMedia/permission denial, surface a clear
        // error and stay in the gate so the user can retry.
        set({ startQueued: false });
        void deps
          .startCapture()
          .then(() => {
            set({ micStarted: true });
            get().dispatch({ type: "set_listening", state: "listening" });
          })
          .catch((err) => {
            surfaceError(
              `Microphone access failed: ${errMessage(err)}. Please allow the microphone and tap to try again.`,
            );
          });
      },

      setVoiceReady(ready) {
        set({ voiceReady: ready });
        if (ready && queuedStart) {
          queuedStart = false;
          set({ startQueued: false });
          get().startMic();
        }
      },

      pushVoiceError(message) {
        surfaceError(message);
      },

      setVoiceIndicator({ vad, finalizing }) {
        set({ vadActive: vad, listeningPhase: finalizing ? "finalizing" : "idle" });
      },

      setMicLevel(level) {
        set({ micLevel: level });
      },

      setInterim(text) {
        set({ interimTranscript: text });
      },

      submitComposerText(text) {
        const trimmed = text.trim();
        if (!trimmed) return;
        set({ interimTranscript: "" });
        void get().submitTranscript(trimmed);
      },

      dispatch(action, author = "user") {
        const result = applyAction(get().app, action, ctxFor(author));
        set({ app: result.state, lastError: result.error ?? null });
        runEffects(result.effects);
      },

      applyResponse,

      updateSettings(patch) {
        // Route settings-dialog changes through the same update_settings action
        // the LLM emits by voice ("switch to dark mode"), so click and voice
        // share one path: the reducer updates settings + emits persist_settings.
        get().dispatch({ type: "update_settings", ...patch });
      },

      submitTranscript(text, sttSeconds) {
        const trimmed = text.trim();
        if (!trimmed) return Promise.resolve();
        // Queue the utterance; the returned promise resolves when THIS turn has
        // been fully processed (not merely enqueued), so callers can await it.
        return enqueueTurn(trimmed, sttSeconds);
      },

      flushPersistQueue: () => drainPromise,

      setDocumentScroll(scroll) {
        set((s) => ({ app: { ...s.app, documentScroll: scroll } }));
      },

      setChatScroll(scroll) {
        set((s) => ({ app: { ...s.app, chatScroll: scroll } }));
      },

      setDocumentText(text) {
        set((s) =>
          s.app.activeDocument
            ? { app: { ...s.app, activeDocument: { ...s.app.activeDocument, text } } }
            : s,
        );
      },
    };
  });

  // Wire the injected STT into the store: a finished utterance runs a turn; VAD
  // drives the pulse indicator.
  deps.stt.onFinal((text) => {
    void store.getState().submitTranscript(text);
  });
  deps.stt.onVad((speaking) => {
    store.setState({ vadActive: speaking });
  });
  // Live partials -> the composer's gray preview. In the real pipeline the
  // VoiceController forwards these (deps.stt here is an inert MockStt); this wiring
  // serves the direct/test path where deps.stt is the live provider.
  deps.stt.onInterim((text) => {
    store.setState({ interimTranscript: text });
  });

  return store;
}
