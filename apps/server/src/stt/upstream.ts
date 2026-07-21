// The real STT upstream: a `ws` WebSocket to OpenAI realtime transcription
// (gpt-realtime-whisper), adapted to the SttUpstream interface the bridge speaks.
// The API key stays server-side (Authorization header, never the browser). This
// path opens a real socket + bills per audio-minute, so it is NEVER exercised in
// tests -- the bridge tests inject a fake upstream. Real end-to-end coverage lives
// in the opt-in live-API tier (needs a key).

import { WebSocket } from "ws";
import type { SttLatency } from "@yammer/shared";
import type { SttUpstream } from "./bridge";

export interface OpenAiUpstreamOptions {
  apiKey: string;
  /** Defaults to gpt-realtime-whisper (the streaming transcription model). */
  model?: string;
  /** Sample rate of the PCM16 frames the client will stream. */
  sampleRate: number;
  latency?: SttLatency;
}

/**
 * Open a realtime-transcription socket to OpenAI and expose it as an SttUpstream.
 * Audio frames are wrapped as `input_audio_buffer.append` (base64 PCM16); upstream
 * events are handed back as raw JSON strings for the bridge to map.
 */
export function openOpenAiUpstream(opts: OpenAiUpstreamOptions): SttUpstream {
  const model = opts.model ?? "gpt-realtime-whisper";
  // Opt-in wire tracing: set YAMMER_STT_DEBUG=1 to print the session config we
  // send and every event OpenAI returns (transcription deltas/completions, errors,
  // rate rejections). Off by default so a normal run stays quiet.
  const debug = !!process.env.YAMMER_STT_DEBUG;
  const trace = (dir: string, payload: unknown) => {
    if (debug) console.log(`[stt upstream ${dir}]`, payload);
  };
  // GA Realtime API: /v1/realtime, NO "OpenAI-Beta" header (that is the removed
  // beta path), and a session.update with session.type "transcription".
  const socket = new WebSocket(
    "wss://api.openai.com/v1/realtime?intent=transcription",
    { headers: { Authorization: `Bearer ${opts.apiKey}` } },
  );

  // Configure the transcription session as soon as the socket opens, before the
  // bridge flushes any buffered audio (this handler is registered first).
  socket.on("open", () => {
    const config = {
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: opts.sampleRate },
            transcription: { model, language: "en" },
            // Disable server-side VAD: the client gates audio on its own VAD and
            // signals utterance boundaries with an explicit commit, so OpenAI must
            // NOT try to auto-endpoint (it never hears the trailing silence, and
            // auto-endpointing conflicts with a manual commit).
            turn_detection: null,
          },
        },
      },
    };
    trace("->", config);
    socket.send(JSON.stringify(config));
  });

  return {
    send: (audio) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: Buffer.from(audio).toString("base64"),
        }),
      );
    },
    commit: () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      trace("->", { type: "input_audio_buffer.commit" });
      socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    },
    close: (code) => socket.close(code),
    onOpen: (cb) => socket.on("open", () => cb()),
    onMessage: (cb) =>
      socket.on("message", (data) => {
        const text = data.toString();
        trace("<-", text);
        cb(text);
      }),
    onClose: (cb) => socket.on("close", () => cb()),
    onError: (cb) => socket.on("error", (err) => cb(err)),
  };
}
