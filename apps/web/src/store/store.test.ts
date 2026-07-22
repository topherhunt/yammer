import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@yammer/shared";
import { createVersion } from "@yammer/core";
import { MockApiClient } from "../api/mock-client";
import type { MockApiConfig } from "../api/mock-client";
import { MockStt } from "../stt/mock-stt";
import { createAppStore } from "./store";

const createV = createVersion({
  id: "v0",
  createdAt: "2026-01-01T00:00:00.000Z",
  documentId: "d1",
  parent: null,
  author: "user",
  kind: "create",
  newText: "the cat sat",
  summary: "Created document",
});

const openDocState: Partial<AppState> = {
  activeDocument: {
    id: "d1",
    name: "Doc",
    text: "the cat sat",
    currentVersionId: "v0",
    currentSeq: 0,
  },
  history: [createV],
  undoStack: ["v0"],
  undoCursor: 0,
};

function makeStore(
  config: {
    api?: MockApiConfig;
    initial?: Partial<AppState>;
    retryDelayMs?: (attempt: number) => number;
    reDrainDelayMs?: number;
    startCapture?: () => Promise<void>;
    voiceReady?: boolean;
  } = {},
) {
  const api = new MockApiClient(config.api);
  const stt = new MockStt();
  let n = 0;
  const store = createAppStore({
    api,
    stt,
    newId: () => `id-${++n}`,
    now: () => "2026-01-01T00:00:00.000Z",
    initial: config.initial ?? openDocState,
    // Drop the backoff in tests; the retry semantics are what we assert, not wall time.
    retryDelayMs: config.retryDelayMs ?? (() => 0),
    // A huge default so the exhausted-retry re-drain timer never fires mid-test
    // (tests that exercise re-drain override it or use the `online` event).
    reDrainDelayMs: config.reDrainDelayMs ?? 10_000_000,
    ...(config.startCapture ? { startCapture: config.startCapture } : {}),
    ...(config.voiceReady !== undefined ? { voiceReady: config.voiceReady } : {}),
  });
  return { store, api, stt };
}

const usage = { sttSeconds: 1, inputTokens: 100, cachedInputTokens: 0, outputTokens: 5 };

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("dispatch of a reducer edit", () => {
  it("applies the edit, appends a version, and persists it", () => {
    const { store, api } = makeStore();
    store.getState().dispatch({ type: "edit_text", edits: [{ find: "cat", replace: "dog" }] });

    const app = store.getState().app;
    expect(app.activeDocument?.text).toBe("the dog sat");
    expect(app.history).toHaveLength(2);
    expect(app.history[1]!.summary).toContain("dog");
    // The edit version was pushed to the backend via a persist_version effect.
    expect(api.persistedVersions.map((v) => v.id)).toEqual(["id-1"]);
    // Chat carries the attributed edit entry.
    const last = app.chat.at(-1);
    expect(last?.kind).toBe("edit");
  });
});

describe("submitTranscript turn loop", () => {
  it("appends the user message, applies the LLM turn, and records usage", async () => {
    const { store } = makeStore({
      api: {
        turnResponder: (req) => ({
          actions: [{ type: "insert_text", position: "end", text: ` ${req.transcript}` }],
          usage: { sttSeconds: 2, inputTokens: 500, cachedInputTokens: 300, outputTokens: 20 },
          raw: {},
        }),
      },
    });

    await store.getState().submitTranscript("on the mat");

    const state = store.getState();
    expect(state.app.activeDocument?.text).toBe("the cat sat on the mat");
    expect(state.usages).toHaveLength(1);
    expect(state.usages[0]!.inputTokens).toBe(500);
    expect(state.sttPhase).toBe("idle");
    const kinds = state.app.chat.map((e) => e.kind);
    expect(kinds).toContain("user_message");
    expect(kinds).toContain("edit");
  });

  it("retries an invalid LLM response a few times, then surfaces a chat error", async () => {
    let calls = 0;
    const { store } = makeStore({
      api: {
        turnResponder: () => {
          calls += 1;
          return {
            actions: [{ type: "not_a_real_action" }],
            usage: { sttSeconds: 1, inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 },
            raw: {},
          };
        },
      },
    });

    await store.getState().submitTranscript("do something weird");

    const state = store.getState();
    // An unusable turn (a UI-driving AI emitting a bad action) is retried before we
    // give up -- three total attempts here, since the mock is always invalid.
    expect(calls).toBe(3);
    const last = state.app.chat.at(-1);
    expect(last?.kind).toBe("error");
    // The document is untouched by an invalid turn.
    expect(state.app.activeDocument?.text).toBe("the cat sat");
    // Each attempt was billed, so usage is recorded once per attempt.
    expect(state.usages).toHaveLength(3);
  });
});

describe("STT wiring", () => {
  it("runs a turn when the mock STT finalizes an utterance", async () => {
    const { store, stt } = makeStore({
      api: {
        turnResponder: (req) => ({
          actions: [{ type: "insert_text", position: "end", text: ` ${req.transcript}` }],
          usage: { sttSeconds: 1, inputTokens: 100, cachedInputTokens: 0, outputTokens: 5 },
          raw: {},
        }),
      },
    });

    stt.emitFinal("again");
    await flush();

    expect(store.getState().app.activeDocument?.text).toBe("the cat sat again");
  });

  it("toggles the VAD pulse flag", () => {
    const { store, stt } = makeStore();
    expect(store.getState().vadActive).toBe(false);
    stt.emitVad(true);
    expect(store.getState().vadActive).toBe(true);
    stt.emitVad(false);
    expect(store.getState().vadActive).toBe(false);
  });
});

describe("dialog + document effects", () => {
  it("loads the document list when the load dialog opens", async () => {
    const { store } = makeStore({
      api: {
        documents: [
          { id: "a", name: "Beta", createdAt: "2026-01-02", updatedAt: "2026-01-05" },
          { id: "b", name: "Alpha", createdAt: "2026-01-01", updatedAt: "2026-01-09" },
        ],
      },
    });

    store.getState().dispatch({ type: "open_dialog", dialog: "load", sort: "name" });
    await flush();

    const app = store.getState().app;
    expect(app.openDialog).toBe("load");
    // Sorted by name.
    expect(app.documents.map((d) => d.name)).toEqual(["Alpha", "Beta"]);
    expect(app.settings.loadDocSort).toBe("name");
  });

  it("restores a prior version through the reducer", () => {
    const { store } = makeStore();
    store.getState().dispatch({ type: "edit_text", edits: [{ find: "cat", replace: "dog" }] });
    expect(store.getState().app.activeDocument?.text).toBe("the dog sat");

    store.getState().dispatch({ type: "restore_version", seq: 0 });
    const app = store.getState().app;
    expect(app.activeDocument?.text).toBe("the cat sat");
    expect(app.chat.at(-1)?.kind).toBe("restore");
  });

  it("creates a fresh document IN-STATE synchronously and resets the spend meter", () => {
    const { store } = makeStore();
    store.getState().usages.push({ sttSeconds: 9, inputTokens: 9, cachedInputTokens: 0, outputTokens: 9 });
    store.getState().dispatch({ type: "new_document", name: "Fresh" });

    // Synchronous: the reducer creates the doc + its seq-0 version in-state, so a
    // same-turn edit and the NEXT turn see it immediately (no async gap that would
    // spawn a duplicate document).
    const state = store.getState();
    expect(state.app.activeDocument?.name).toBe("Fresh");
    expect(state.app.activeDocument?.text).toBe("");
    expect(state.app.history).toHaveLength(1);
    expect(state.app.history[0]!.kind).toBe("create");
    expect(state.usages).toEqual([]); // spend meter resets on the new document
    // A visible divider marks the new document in the (retained) transcript.
    expect(state.app.chat.at(-1)).toMatchObject({
      kind: "document",
      event: "created",
      name: "Fresh",
    });
  });

  it("applies new_document + insert_text in ONE turn (the same-turn insert that used to fail)", async () => {
    // Exactly the reported failure: no document open, then a single turn that both
    // creates a document and writes into it. The insert must land in the new doc,
    // not error with "no document open".
    const { store, api } = makeStore({ initial: { activeDocument: null } });

    store.getState().applyResponse({
      actions: [
        { type: "new_document", name: "Poem" },
        { type: "insert_text", position: "end", text: "Once upon a midnight dreary" },
      ],
    });

    const doc = store.getState().app.activeDocument!;
    expect(doc.name).toBe("Poem");
    expect(doc.text).toBe("Once upon a midnight dreary"); // same-turn insert landed
    expect(store.getState().app.chat.some((e) => e.kind === "error")).toBe(false);

    // Both versions persist in order (v0 create, then v1 insert); the create carries
    // the document name so the server can auto-create the document row from it.
    await store.getState().flushPersistQueue();
    expect(api.persistedVersions.map((v) => v.seq)).toEqual([0, 1]);
    expect(api.persistedVersions[0]!.kind).toBe("create");
    expect(api.persistedVersions.every((v) => v.documentId === doc.id)).toBe(true);
    expect(api.persistedNames[0]).toBe("Poem");
  });
});

describe("durable version persistence", () => {
  it("persists the undo timeline alongside the version (N3)", async () => {
    const { store, api } = makeStore();
    store.getState().dispatch({ type: "edit_text", edits: [{ find: "cat", replace: "dog" }] });
    await store.getState().flushPersistQueue();

    expect(api.persistedVersions).toHaveLength(1);
    const app = store.getState().app;
    // The undo timeline advanced past the create version, and that exact state
    // was sent with the persisted version.
    expect(app.undoStack).toHaveLength(2);
    expect(app.undoCursor).toBe(1);
    expect(api.persistedUndo[0]).toEqual({
      undoStack: app.undoStack,
      undoCursor: app.undoCursor,
    });
  });

  it("retries a failed persist and surfaces the error without dropping the edit", async () => {
    const { store, api } = makeStore({
      api: {
        persistFailer: () => {
          throw new Error("network down");
        },
      },
    });

    store.getState().dispatch({ type: "edit_text", edits: [{ find: "cat", replace: "dog" }] });
    // The edit is applied locally regardless of the save outcome.
    expect(store.getState().app.activeDocument?.text).toBe("the dog sat");
    await store.getState().flushPersistQueue();

    // Three attempts (MAX_PERSIST_TRIES) before giving up -- no single silent try.
    expect(api.persistAttempts).toBe(3);
    // Nothing recorded as saved (every attempt threw), and the failure is loud.
    expect(api.persistedVersions).toHaveLength(0);
    expect(store.getState().app.chat.at(-1)).toMatchObject({ kind: "error" });
    expect(store.getState().lastError).toMatch(/could not save/i);
  });

  it("reloads and reconciles the document on a 409 seq-conflict (no silent drop)", async () => {
    const serverVersion = createVersion({
      id: "srv-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      documentId: "d1",
      parent: null,
      author: "user",
      kind: "create",
      newText: "server wins",
      summary: "Created document",
    });
    const { store, api } = makeStore({
      api: {
        persistFailer: () => {
          const err = new Error("seq conflict") as Error & { status: number };
          err.status = 409;
          throw err;
        },
        documentPayloads: {
          d1: {
            document: {
              id: "d1",
              name: "Doc",
              text: "server wins",
              currentVersionId: "srv-1",
              currentSeq: 0,
            },
            history: [serverVersion],
          },
        },
      },
    });

    store.getState().dispatch({ type: "edit_text", edits: [{ find: "cat", replace: "dog" }] });
    await store.getState().flushPersistQueue();

    const app = store.getState().app;
    // A 409 is not retried -- it means reconcile, not backoff.
    expect(api.persistAttempts).toBe(1);
    // The authoritative server document + history replaced local state.
    expect(app.activeDocument?.text).toBe("server wins");
    expect(app.history.map((v) => v.id)).toEqual(["srv-1"]);
    expect(app.undoStack).toEqual(["srv-1"]);
    expect(app.undoCursor).toBe(0);
    // The user is told, loudly, that the document changed elsewhere.
    expect(app.chat.at(-1)).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/changed on another device/i),
    });
    expect(store.getState().lastError).toMatch(/reloaded from the server/i);
  });
});

describe("persist re-drain after exhausted retries", () => {
  it("resumes and persists a stranded edit when the `online` event fires", async () => {
    let allow = false;
    const { store, api } = makeStore({
      api: {
        persistFailer: () => {
          // Fail until connectivity is 'restored', then let it through.
          if (!allow) throw new Error("offline");
        },
      },
    });

    store.getState().dispatch({ type: "edit_text", edits: [{ find: "cat", replace: "dog" }] });
    await store.getState().flushPersistQueue();

    // Exhausted the retries and paused at the head -- the edit is kept, not dropped.
    expect(api.persistedVersions).toHaveLength(0);
    expect(store.getState().app.chat.at(-1)).toMatchObject({ kind: "error" });

    // Connectivity returns: the queue resumes without any further user action and
    // the stranded edit finally persists.
    allow = true;
    window.dispatchEvent(new Event("online"));
    await store.getState().flushPersistQueue();

    expect(api.persistedVersions.map((v) => v.id)).toEqual(["id-1"]);
  });

  it("reschedules a delayed re-drain (does not need another edit) after exhaustion", async () => {
    let allow = false;
    const { store, api } = makeStore({
      reDrainDelayMs: 0, // fire on the next macrotask
      api: {
        persistFailer: () => {
          if (!allow) throw new Error("offline");
        },
      },
    });

    store.getState().dispatch({ type: "edit_text", edits: [{ find: "cat", replace: "dog" }] });
    await store.getState().flushPersistQueue();
    expect(api.persistedVersions).toHaveLength(0);

    // The re-drain timer fires on its own; the recovered connection persists it.
    allow = true;
    await flush(); // let the 0ms re-drain timer run
    await store.getState().flushPersistQueue();
    expect(api.persistedVersions.map((v) => v.id)).toEqual(["id-1"]);
  });
});

describe("scoped 409 conflict (other documents' edits survive)", () => {
  it("drops only the conflicting document's queued edits, not another doc's", async () => {
    // d1 (the initial doc) will 409; a new document's create version must survive.
    const { store, api } = makeStore({
      api: {
        persistFailer: (_attempt, version) => {
          if (version.documentId === "d1") {
            const err = new Error("seq conflict") as Error & { status: number };
            err.status = 409;
            throw err;
          }
        },
        documentPayloads: {
          d1: {
            document: { id: "d1", name: "Doc", text: "server", currentVersionId: "v0", currentSeq: 0 },
            history: [createV],
          },
        },
      },
    });

    // Queue two persists in one synchronous tick, before the drain's first `await`
    // yields: an edit on d1 (will 409), then -- switching to a second document --
    // an edit on d2. Both sit in the queue together, which is what makes the 409
    // reconcile's per-document scoping meaningful.
    const d2CreateV = createVersion({
      id: "d2v0",
      createdAt: "2026-01-01T00:00:00.000Z",
      documentId: "d2",
      parent: null,
      author: "user",
      kind: "create",
      newText: "",
      summary: "Created document",
    });
    store.getState().dispatch({ type: "edit_text", edits: [{ find: "cat", replace: "dog" }] });
    store.setState((s) => ({
      app: {
        ...s.app,
        activeDocument: { id: "d2", name: "Second", text: "", currentVersionId: "d2v0", currentSeq: 0 },
        history: [d2CreateV],
        undoStack: ["d2v0"],
        undoCursor: 0,
      },
    }));
    store.getState().dispatch({ type: "insert_text", position: "end", text: "hi" });
    await store.getState().flushPersistQueue();

    // The d1 edit conflicted and was reconciled away; the OTHER document's edit was
    // NOT dropped -- it persisted.
    const persistedDocs = api.persistedVersions.map((v) => v.documentId);
    expect(persistedDocs).not.toContain("d1");
    expect(persistedDocs).toContain("d2");
    // The 409 was surfaced to the user.
    expect(store.getState().app.chat.some((e) => e.kind === "error")).toBe(true);
  });
});

describe("voice-error channel + capture-start gating", () => {
  it("pushVoiceError surfaces a voice failure into the chat error log", () => {
    const { store } = makeStore();
    store.getState().pushVoiceError("STT connection lost -- reconnecting…");
    expect(store.getState().app.chat.at(-1)).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/reconnect/i),
    });
    expect(store.getState().lastError).toMatch(/reconnect/i);
  });

  it("does NOT enter listening and surfaces an error when capture is denied", async () => {
    const startCapture = () => Promise.reject(new Error("Permission denied"));
    const { store } = makeStore({ startCapture });

    store.getState().startMic();
    await flush();

    // The mic was never confirmed: stay in the gate (micStarted false), and the
    // listening state must NOT lie.
    expect(store.getState().micStarted).toBe(false);
    expect(store.getState().app.listening).not.toBe("listening");
    expect(store.getState().app.chat.at(-1)).toMatchObject({ kind: "error" });
    expect(store.getState().lastError).toMatch(/microphone access failed/i);
  });

  it("enters listening only after capture is confirmed", async () => {
    const startCapture = () => Promise.resolve();
    const { store } = makeStore({ startCapture });

    store.getState().startMic();
    // Not yet: capture confirmation is async, so no optimistic flip.
    expect(store.getState().micStarted).toBe(false);

    await flush();
    expect(store.getState().micStarted).toBe(true);
    expect(store.getState().app.listening).toBe("listening");
  });
});

describe("early-tap race (voice pipeline not yet ready)", () => {
  it("queues a tap that arrives before ready, then starts on setVoiceReady", async () => {
    let capture: (() => Promise<void>) | null = null;
    const { store } = makeStore({
      voiceReady: false,
      startCapture: () => (capture ? capture() : Promise.resolve()),
    });
    capture = () => Promise.resolve();

    // The user taps before the late-bound voice pipeline is ready.
    store.getState().startMic();
    expect(store.getState().startQueued).toBe(true);
    expect(store.getState().micStarted).toBe(false);
    expect(store.getState().app.listening).not.toBe("listening");

    // The pipeline becomes ready: the queued tap runs and listening actually starts.
    store.getState().setVoiceReady(true);
    await flush();
    expect(store.getState().startQueued).toBe(false);
    expect(store.getState().micStarted).toBe(true);
    expect(store.getState().app.listening).toBe("listening");
  });
});

describe("serialized voice turns", () => {
  it("processes rapid utterances one at a time so the second sees the first's edit", async () => {
    const { store, api } = makeStore({
      api: {
        turnResponses: [
          { actions: [{ type: "insert_text", position: "end", text: " ONE" }], usage, raw: {} },
          { actions: [{ type: "edit_text", edits: [{ find: "ONE", replace: "TWO" }] }], usage, raw: {} },
        ],
      },
    });

    // Fire two utterances back-to-back without awaiting the first.
    const p1 = store.getState().submitTranscript("first");
    const p2 = store.getState().submitTranscript("second");
    await Promise.all([p1, p2]);

    // Second turn's edit anchor ("ONE") only existed because the first turn had
    // already committed -- proving strict sequencing, not a race.
    expect(store.getState().app.activeDocument?.text).toBe("the cat sat TWO");
    expect(store.getState().app.chat.some((e) => e.kind === "error")).toBe(false);
    // The second turn re-assembled context against the first turn's result.
    expect(api.turnRequests[1]!.context.document?.numberedText).toContain("ONE");
  });

  it("resets sttPhase to idle when the turn request throws (never freezes the mic)", async () => {
    const { store } = makeStore({
      api: {
        turnResponder: () => {
          throw new Error("relay exploded");
        },
      },
    });

    await store.getState().submitTranscript("hello");

    expect(store.getState().sttPhase).toBe("idle");
    expect(store.getState().app.chat.at(-1)).toMatchObject({ kind: "error" });
  });

  it("surfaces an error and resets sttPhase when applying the turn throws (mic not frozen)", async () => {
    // A non-EditError thrown from inside the reducer (here: version-id minting)
    // must not leave sttPhase stuck at "sending" on the singleton store.
    let n = 0;
    const api = new MockApiClient({
      turnResponder: () => ({
        actions: [{ type: "insert_text", position: "end", text: " x" }],
        usage,
        raw: {},
      }),
    });
    const store = createAppStore({
      api,
      stt: new MockStt(),
      now: () => "2026-01-01T00:00:00.000Z",
      newId: () => {
        n += 1;
        // Call 1 mints the user_message id; call 2 is the reducer minting the new
        // version -- throw there so applyTurn throws mid-turn.
        if (n === 2) throw new Error("reducer boom");
        return `id-${n}`;
      },
      initial: openDocState,
    });

    await store.getState().submitTranscript("go");

    expect(store.getState().sttPhase).toBe("idle");
    expect(store.getState().app.chat.some((e) => e.kind === "error")).toBe(true);
  });
});

describe("effect failure surfacing", () => {
  it("surfaces an error entry when a load_document effect rejects", async () => {
    // No document payloads configured, so the mock getDocument rejects.
    const { store } = makeStore({ api: {} });

    store.getState().dispatch({ type: "load_document", documentId: "missing" });
    await flush();

    expect(store.getState().app.chat.at(-1)).toMatchObject({ kind: "error" });
    expect(store.getState().lastError).toMatch(/loading the document/i);
  });
});

describe("research turn UX", () => {
  it("stages thinking-status, lands the digested note, and folds usage into the meter", async () => {
    const researchUsage = {
      sttSeconds: 0,
      inputTokens: 500,
      cachedInputTokens: 0,
      outputTokens: 80,
    };
    const { store } = makeStore({
      initial: openDocState,
      api: { researchSummary: "ALS AAC devices summary.", researchUsage },
    });

    // The research action is what the LLM (or a UI control) dispatches.
    store.getState().dispatch({ type: "research", queries: ["als aac"] });
    await flush();

    const chat = store.getState().app.chat;
    // Staged thinking status: reducer emits "Searching…", the effect emits "Reading…".
    const statuses = chat
      .filter((e) => e.kind === "thinking")
      .map((e) => (e as { status: string }).status);
    expect(statuses).toEqual(["Searching the web…", "Reading results…"]);

    // The digested note lands as a research entry (not raw pages).
    const research = chat.find((e) => e.kind === "research");
    expect(research).toMatchObject({ kind: "research", summary: "ALS AAC devices summary." });

    // Research usage is folded into the spend-meter totals just like a turn.
    expect(store.getState().usages).toContainEqual(researchUsage);
  });

  it("surfaces an error (not a silent drop) when the research call fails", async () => {
    const { store, api } = makeStore({ initial: openDocState });
    api.research = () => Promise.reject(new Error("tavily down"));

    store.getState().dispatch({ type: "research", queries: ["x"] });
    await flush();

    expect(store.getState().app.chat.at(-1)).toMatchObject({ kind: "error" });
    expect(store.getState().lastError).toMatch(/research/i);
  });
});

describe("diagnostic-log download", () => {
  it("GETs the diagnostic log for the active document and triggers a file download", async () => {
    const createURL = vi.fn((_blob: Blob) => "blob:diag");
    const revokeURL = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeURL;
    const downloads: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });

    try {
      const { store, api } = makeStore({ initial: openDocState });
      store.getState().dispatch({ type: "download_diagnostics" });
      await flush();

      // The server endpoint was hit for the active document...
      expect(api.diagnosticsRequests).toEqual(["d1"]);
      // ...and a blob object URL + anchor download were triggered.
      expect(createURL).toHaveBeenCalledTimes(1);
      expect(createURL.mock.calls[0]![0]).toBeInstanceOf(Blob);
      expect(downloads).toEqual(["Doc-diagnostics.json"]);
      expect(store.getState().app.chat.some((e) => e.kind === "error")).toBe(false);
    } finally {
      clickSpy.mockRestore();
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
      delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
  });

  it("surfaces an error in the chat channel when the diagnostics download fails", async () => {
    const { store, api } = makeStore({ initial: openDocState });
    api.getDiagnostics = () => Promise.reject(new Error("network down"));

    store.getState().dispatch({ type: "download_diagnostics" });
    await flush();

    expect(store.getState().app.chat.at(-1)).toMatchObject({ kind: "error" });
    expect(store.getState().lastError).toMatch(/diagnostic log/i);
  });
});
