import { beforeEach, describe, expect, it } from "vitest";
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

  it("surfaces a chat error when the LLM returns an invalid action", async () => {
    const { store } = makeStore({
      api: {
        turnResponder: () => ({
          actions: [{ type: "not_a_real_action" }],
          usage: { sttSeconds: 1, inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 },
          raw: {},
        }),
      },
    });

    await store.getState().submitTranscript("do something weird");

    const state = store.getState();
    const last = state.app.chat.at(-1);
    expect(last?.kind).toBe("error");
    // The document is untouched by an invalid turn.
    expect(state.app.activeDocument?.text).toBe("the cat sat");
    // Usage is still recorded so the spend meter reflects the (billed) call.
    expect(state.usages).toHaveLength(1);
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

    store.getState().dispatch({ type: "restore_version", versionId: "v0" });
    const app = store.getState().app;
    expect(app.activeDocument?.text).toBe("the cat sat");
    expect(app.chat.at(-1)?.kind).toBe("restore");
  });

  it("creates a fresh document and resets the spend meter", () => {
    const { store } = makeStore();
    store.getState().usages.push({ sttSeconds: 9, inputTokens: 9, cachedInputTokens: 0, outputTokens: 9 });
    store.getState().dispatch({ type: "new_document", name: "Fresh" });

    const state = store.getState();
    expect(state.app.activeDocument?.name).toBe("Fresh");
    expect(state.app.activeDocument?.text).toBe("");
    expect(state.app.history).toHaveLength(1);
    expect(state.usages).toEqual([]);
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
