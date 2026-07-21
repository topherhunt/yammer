import { describe, expect, it } from "vitest";
import type { AppState, ListeningState } from "@yammer/shared";
import { MockApiClient } from "../api/mock-client";
import { MockStt } from "../stt/mock-stt";
import { FakeSfx } from "../voice/fakes";
import { createAppStore } from "./store";

// The Phase-4 edge wiring: the play_sfx effect goes to the injected Sfx and the
// set_listening effect drives the listening machine (via onSetListening).

function makeStore(initial?: Partial<AppState>) {
  const sfx = new FakeSfx();
  const setListenings: ListeningState[] = [];
  let n = 0;
  const store = createAppStore({
    api: new MockApiClient(),
    stt: new MockStt(),
    sfx,
    onSetListening: (state) => setListenings.push(state),
    newId: () => `id-${++n}`,
    now: () => "2026-01-01T00:00:00.000Z",
    initial,
  });
  return { store, sfx, setListenings };
}

describe("play_sfx effect -> Sfx", () => {
  it("plays the mute tone when muting and the unmute tone when starting to listen", () => {
    const { store, sfx } = makeStore();
    store.getState().dispatch({ type: "set_listening", state: "muted" });
    expect(sfx.played).toEqual(["mute"]);
    store.getState().dispatch({ type: "set_listening", state: "listening" });
    expect(sfx.played).toEqual(["mute", "unmute"]);
  });

  it("stays silent when SFX is disabled in settings", () => {
    const { store, sfx } = makeStore({ settings: { ...settingsWith({ sfxEnabled: false }) } });
    store.getState().dispatch({ type: "set_listening", state: "muted" });
    expect(sfx.played).toEqual([]);
  });
});

describe("set_listening effect -> listening machine", () => {
  it("routes each mode transition to onSetListening", () => {
    const { store, setListenings } = makeStore();
    store.getState().dispatch({ type: "set_listening", state: "paused" });
    store.getState().dispatch({ type: "set_listening", state: "muted" });
    store.getState().dispatch({ type: "set_listening", state: "listening" });
    expect(setListenings).toEqual(["paused", "muted", "listening"]);
  });
});

describe("tap-to-start gate hook", () => {
  it("startMic dismisses the gate and starts listening through the machine", () => {
    const { store, setListenings } = makeStore();
    expect(store.getState().micStarted).toBe(false);
    store.getState().startMic();
    expect(store.getState().micStarted).toBe(true);
    expect(store.getState().app.listening).toBe("listening");
    expect(setListenings).toEqual(["listening"]);
  });
});

describe("setVoiceIndicator", () => {
  it("mirrors the machine's derived pulse + radial signals into the store", () => {
    const { store } = makeStore();
    store.getState().setVoiceIndicator({ vad: true, finalizing: false });
    expect(store.getState().vadActive).toBe(true);
    expect(store.getState().listeningPhase).toBe("idle");
    store.getState().setVoiceIndicator({ vad: false, finalizing: true });
    expect(store.getState().vadActive).toBe(false);
    expect(store.getState().listeningPhase).toBe("finalizing");
  });
});

// Minimal Settings builder so the sfx-disabled case can override one flag without
// restating the whole shape.
function settingsWith(overrides: Partial<AppState["settings"]>): AppState["settings"] {
  return {
    theme: "system",
    loadDocSort: "updated",
    sfxEnabled: true,
    silenceThresholdMs: 800,
    optimisticSendMs: 400,
    chatCompactThreshold: 24,
    ...overrides,
  };
}
