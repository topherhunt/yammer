import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import type {
  Action,
  ActiveDocument,
  AppState,
  Author,
  Effect,
  LlmResponse,
  ScrollState,
  SfxSound,
  SttProvider,
  Usage,
} from "@yammer/shared";
import { initialState } from "@yammer/shared";
import {
  applyAction,
  applyTurn,
  assembleContext,
  createVersion,
  parseLlmResponse,
} from "@yammer/core";
import type { Ctx } from "@yammer/core";
import type { ApiClient } from "../api/client";
import { copyToClipboard, downloadFile, playSfx } from "./browser-effects";

// The Zustand store is the edge: it holds AppState, drives the pure reducer with
// validated actions, and carries out the Effect[] the reducer returns (persist,
// load, research, scroll, clipboard, download, SFX). The UI is a pure function
// of `app`. Voice/LLM/network are injected (ApiClient, SttProvider) so the whole
// store is testable with mocks and never touches a real API.

export type SttPhase = "idle" | "finalizing" | "sending";

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
  sttPhase: SttPhase;
  lastError: string | null;
  scrollCommand: ScrollCommand | null;

  /** Apply one action from a UI control (default author "user"). */
  dispatch: (action: Action, author?: Author) => void;
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
}

export interface StoreDeps {
  api: ApiClient;
  stt: SttProvider;
  now?: () => string;
  newId?: () => string;
  initial?: Partial<AppState>;
}

export function createAppStore(deps: StoreDeps): StoreApi<AppStore> {
  let idCounter = 0;
  const newId = deps.newId ?? (() => `id-${++idCounter}`);
  const now = deps.now ?? (() => new Date().toISOString());
  let scrollNonce = 0;

  const store = createStore<AppStore>((set, get) => {
    const ctxFor = (author: Author): Ctx => ({ newId, now, author });

    function pushEntry(entry: AppState["chat"][number]): void {
      set((s) => ({ app: { ...s.app, chat: [...s.app.chat, entry] } }));
    }

    function sfx(sound: SfxSound): void {
      if (get().app.settings.sfxEnabled) playSfx(sound);
    }

    function handleCreateDocument(localId: string, name?: string): void {
      const version = createVersion({
        id: newId(),
        createdAt: now(),
        documentId: localId,
        parent: null,
        author: "user",
        kind: "create",
        newText: "",
        summary: "Created document",
      });
      const document: ActiveDocument = {
        id: localId,
        name: name ?? "Untitled",
        text: "",
        currentVersionId: version.id,
        currentSeq: 0,
      };
      set((s) => ({
        app: {
          ...s.app,
          activeDocument: document,
          history: [version],
          undoStack: [version.id],
          undoCursor: 0,
          openDialog: null,
        },
        usages: [],
      }));
      void deps.api.persistVersion(version);
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
    }

    async function handleLoadDocuments(sort: AppState["settings"]["loadDocSort"]): Promise<void> {
      const documents = await deps.api.listDocuments(sort);
      set((s) => ({ app: { ...s.app, documents } }));
    }

    async function handleResearch(queries: string[]): Promise<void> {
      const summary = await deps.api.research(queries);
      pushEntry({ kind: "research", id: newId(), at: now(), summary });
    }

    function handleExport(documentId: string, format: "md" | "docx"): void {
      const doc = get().app.activeDocument;
      if (!doc || doc.id !== documentId) return;
      const safeName = doc.name.replace(/[^\w.-]+/g, "_") || "document";
      if (format === "md") {
        downloadFile(`${safeName}.md`, doc.text, "text/markdown");
        return;
      }
      void deps.api.exportDocx(documentId).then((blob) => {
        downloadFile(`${safeName}.docx`, blob, blob.type);
      });
    }

    function handleDiagnostics(): void {
      const s = get();
      const doc = s.app.activeDocument;
      const payload = {
        document: doc ? { id: doc.id, name: doc.name } : null,
        exportedAt: now(),
        usages: s.usages,
        history: s.app.history,
        chat: s.app.chat,
      };
      const name = doc ? doc.name.replace(/[^\w.-]+/g, "_") : "diagnostics";
      downloadFile(`${name}-diagnostics.json`, JSON.stringify(payload, null, 2), "application/json");
    }

    function applyListening(state: AppState["listening"]): void {
      if (state === "listening") deps.stt.start();
      else deps.stt.stop();
      if (state !== "listening") set({ vadActive: false, sttPhase: "idle" });
    }

    function runEffects(effects: Effect[]): void {
      for (const effect of effects) {
        switch (effect.type) {
          case "persist_version":
            void deps.api.persistVersion(effect.version);
            break;
          case "create_document":
            handleCreateDocument(effect.localId, effect.name);
            break;
          case "load_document":
            void handleLoadDocument(effect);
            break;
          case "load_documents":
            void handleLoadDocuments(effect.sort);
            break;
          case "rename_document":
            void deps.api.renameDocument(effect.documentId, effect.name);
            break;
          case "run_research":
            void handleResearch(effect.queries);
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
            void copyToClipboard(effect.text);
            break;
          case "export_document":
            handleExport(effect.documentId, effect.format);
            break;
          case "play_sfx":
            sfx(effect.sound);
            break;
          case "persist_settings":
            void deps.api.persistSettings(effect.settings);
            break;
          case "download_diagnostics":
            handleDiagnostics();
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

    return {
      app: initialState(deps.initial),
      usages: [],
      vadActive: false,
      sttPhase: "idle",
      lastError: null,
      scrollCommand: null,

      dispatch(action, author = "user") {
        const result = applyAction(get().app, action, ctxFor(author));
        set({ app: result.state, lastError: result.error ?? null });
        runEffects(result.effects);
      },

      applyResponse,

      async submitTranscript(text, sttSeconds) {
        const trimmed = text.trim();
        if (!trimmed) return;
        set((s) => ({
          app: {
            ...s.app,
            chat: [
              ...s.app.chat,
              { kind: "user_message", id: newId(), at: now(), text: trimmed },
            ],
          },
          sttPhase: "sending",
        }));

        const context = assembleContext(get().app);
        const documentId = get().app.activeDocument?.id;
        let result;
        try {
          result = await deps.api.turn({
            transcript: trimmed,
            context,
            ...(documentId !== undefined ? { documentId } : {}),
            ...(sttSeconds !== undefined ? { sttSeconds } : {}),
          });
        } catch (err) {
          pushEntry({
            kind: "error",
            id: newId(),
            at: now(),
            message: `Turn request failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          set({ sttPhase: "idle", lastError: "Turn request failed." });
          return;
        }

        const parsed = parseLlmResponse({
          chatMessage: result.chatMessage,
          actions: result.actions,
        });
        if (!parsed.ok) {
          pushEntry({
            kind: "error",
            id: newId(),
            at: now(),
            message: `Invalid LLM response: ${parsed.error}`,
          });
          set((s) => ({
            usages: [...s.usages, result.usage],
            sttPhase: "idle",
            lastError: parsed.error,
          }));
          return;
        }

        applyResponse(parsed.response, result.usage);
        set({ sttPhase: "idle" });
      },

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

  return store;
}
