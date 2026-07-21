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

function makeStore(config: { api?: MockApiConfig; initial?: Partial<AppState> } = {}) {
  const api = new MockApiClient(config.api);
  const stt = new MockStt();
  let n = 0;
  const store = createAppStore({
    api,
    stt,
    newId: () => `id-${++n}`,
    now: () => "2026-01-01T00:00:00.000Z",
    initial: config.initial ?? openDocState,
  });
  return { store, api, stt };
}

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
