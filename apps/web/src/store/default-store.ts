import { createVersion } from "@yammer/core";
import type { ListeningState, SfxSound } from "@yammer/shared";
import type { ApiClient } from "../api/client";
import { FetchApiClient } from "../api/fetch-client";
import { MockApiClient } from "../api/mock-client";
import { MockStt } from "../stt/mock-stt";
import type { Sfx } from "../voice/interfaces";
import type { VoiceController } from "../voice/voice-controller";
import { createAppStore } from "./store";
import type { AppStore } from "./store";
import type { StoreApi } from "zustand/vanilla";

// The app's default store for local dev/demo. When VITE_API_BASE is set it talks
// to the real backend via FetchApiClient; otherwise it runs entirely on mocks
// with a small seed document and a canned "echo dictation" turn response, so the
// UI is explorable end to end without a backend or any spend. STT is still mocked
// until Phase 4 wires the real gpt-realtime-whisper pipeline.

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

  const apiBase = import.meta.env.VITE_API_BASE;
  if (apiBase) {
    // Real backend: the fetch client is authoritative-store-backed and carries the
    // session cookie. No seed data -- documents come from the server.
    const api: ApiClient = new FetchApiClient(apiBase);

    // Wire the real voice pipeline. It is late-bound through a dynamic import so
    // the browser-only mic/VAD adapters (and onnxruntime-web) never load in the
    // test/module graph. Until it resolves, the forwarding shims below are inert.
    let voice: VoiceController | null = null;
    let voiceSfx: Sfx | null = null;
    const store = createAppStore({
      api,
      stt: new MockStt(), // inert here; the VoiceController owns real capture
      sfx: {
        preload: async () => {},
        play: (sound: SfxSound) => voiceSfx?.play(sound),
      },
      onSetListening: (state: ListeningState) => voice?.setListening(state),
    });
    singleton = store;
    void import("../voice/create-voice").then(({ createVoice }) => {
      const created = createVoice(store, apiBase);
      voice = created.controller;
      voiceSfx = created.sfx;
    });
    return singleton;
  }

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
