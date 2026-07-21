import type { StoreApi } from "zustand/vanilla";
import type { AppStore } from "../store/store";
import { WsSttClient } from "../stt/ws-stt";
import { BrowserMicCapture } from "./mic-capture";
import { SileroVadDetector } from "./vad";
import { VoskWakeWord } from "./vosk-wake-word";
import { WebAudioSfx } from "./sfx";
import { VoiceController } from "./voice-controller";
import type { Sfx } from "./interfaces";
import type { WebSocketLike } from "../stt/ws-stt";

// Browser-only assembly of the real voice pipeline. This module statically pulls
// in the real mic/VAD adapters (and via vad.ts, onnxruntime-web), so it must only
// ever be reached through the dynamic import in default-store.ts -- never in the
// test/module graph. Everything it wires is exercised in unit tests through the
// interfaces; this factory is verified later in a real browser with real keys.

/** Ceiling on how long to await an STT final while `finalizing` before surfacing
 * a retryable error instead of hanging. Deliberately generous -- only a genuinely
 * lost final (dropped socket) should trip it. */
const FINALIZE_TIMEOUT_MS = 8000;

/** Derive the ws(s):// STT endpoint from the http(s) API base. */
function sttUrlFrom(apiBase: string): string {
  const url = new URL(apiBase || "/", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/stt`;
  url.search = "";
  return url.toString();
}

export interface CreatedVoice {
  controller: VoiceController;
  sfx: Sfx;
}

export function createVoice(
  store: StoreApi<AppStore>,
  apiBase: string,
): CreatedVoice {
  const sttUrl = sttUrlFrom(apiBase);
  const sfx = new WebAudioSfx();
  void sfx.preload();

  const mic = new BrowserMicCapture();
  const vad = new SileroVadDetector();
  const stt = new WsSttClient({
    socketFactory: () => new WebSocket(sttUrl) as unknown as WebSocketLike,
    mic,
    vad,
    latency: "low",
    // Route socket/protocol/reconnect failures into the chat error log via the
    // store's public voice-error channel (shown + announced via aria-live).
    onError: (message) => store.getState().pushVoiceError(message),
  });
  // Open-source, keyless Vosk spotter for "Yammer, wake up". The model URL is
  // configurable; place a small Vosk model .tar.gz at the default public path.
  const wakeWord = new VoskWakeWord({
    modelUrl: import.meta.env.VITE_VOSK_MODEL_URL,
  });

  const controller = new VoiceController({
    stt,
    wakeWord,
    sfx,
    submit: (text, seconds) => {
      void store.getState().submitTranscript(text, seconds);
    },
    reflect: (indicator) => store.getState().setVoiceIndicator(indicator),
    // A wake-word hit routes through a set_listening action so the reducer stays
    // authoritative (updates app.listening + plays the unmute SFX).
    onResumeRequested: () =>
      store.getState().dispatch({ type: "set_listening", state: "listening" }),
    // Finalize-timeout + autonomous capture failures surface through the same
    // public voice-error channel so they are shown and announced.
    notifyError: (message) => store.getState().pushVoiceError(message),
    graceMs: store.getState().app.settings.optimisticSendMs,
    // No dedicated setting (Settings is frozen); a generous fixed ceiling that
    // only trips when the STT final genuinely never lands (e.g. a dropped socket).
    finalizeMs: FINALIZE_TIMEOUT_MS,
  });

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) controller.pageHidden();
      else controller.pageVisible();
    });
  }

  return { controller, sfx };
}
