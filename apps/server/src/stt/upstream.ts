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
  const socket = new WebSocket(
    "wss://api.openai.com/v1/realtime?intent=transcription",
    {
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    },
  );

  // Configure the transcription session as soon as the socket opens, before the
  // bridge flushes any buffered audio (this handler is registered first).
  socket.on("open", () => {
    socket.send(
      JSON.stringify({
        type: "transcription_session.update",
        session: {
          input_audio_format: "pcm16",
          input_audio_transcription: { model },
          // Endpointing + latency tuning is finalized in the live voice build.
        },
      }),
    );
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
    close: (code) => socket.close(code),
    onOpen: (cb) => socket.on("open", () => cb()),
    onMessage: (cb) => socket.on("message", (data) => cb(data.toString())),
    onClose: (cb) => socket.on("close", () => cb()),
    onError: (cb) => socket.on("error", (err) => cb(err)),
  };
}
