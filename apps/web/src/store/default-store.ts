import { createVersion } from "@yammer/core";
import { MockApiClient } from "../api/mock-client";
import { MockStt } from "../stt/mock-stt";
import { createAppStore } from "./store";
import type { AppStore } from "./store";
import type { StoreApi } from "zustand/vanilla";

// The app's default store for local dev/demo. Until Phase 4 wires the real
// gpt-realtime-whisper STT and a fetch-backed ApiClient, it runs entirely on
// mocks with a small seed document and a canned "reword" turn response, so the
// UI is explorable end to end without a backend or any spend.

const seedId = "seed-doc";
const seedText =
  "# Notes\n\nYammer lets me write with my voice.\n\nEvery edit is saved in history.";
const seedCreate = createVersion({
  id: "seed-v0",
  createdAt: "2026-07-01T00:00:00.000Z",
  documentId: seedId,
  parent: null,
  author: "user",
  kind: "create",
  newText: seedText,
  summary: "Created document",
});

let singleton: StoreApi<AppStore> | null = null;

export function getDefaultStore(): StoreApi<AppStore> {
  if (singleton) return singleton;

  const api = new MockApiClient({
    documents: [
      {
        id: seedId,
        name: "Notes",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    documentPayloads: {
      [seedId]: {
        document: {
          id: seedId,
          name: "Notes",
          text: seedText,
          currentVersionId: seedCreate.id,
          currentSeq: 0,
        },
        history: [seedCreate],
      },
    },
    // Echo dictation into the document so speaking appends text end-to-end.
    turnResponder: (req) => ({
      actions: [{ type: "insert_text", position: "end", text: `\n\n${req.transcript}` }],
      usage: { sttSeconds: 3, inputTokens: 1200, cachedInputTokens: 900, outputTokens: 40 },
      raw: {},
    }),
  });

  singleton = createAppStore({
    api,
    stt: new MockStt(),
    initial: {
      activeDocument: {
        id: seedId,
        name: "Notes",
        text: seedText,
        currentVersionId: seedCreate.id,
        currentSeq: 0,
      },
      history: [seedCreate],
      undoStack: [seedCreate.id],
      undoCursor: 0,
    },
  });
  return singleton;
}
