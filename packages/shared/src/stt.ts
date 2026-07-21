// The WebSocket protocol between the browser mic pipeline and the server-side
// proxy to OpenAI realtime transcription (gpt-realtime-whisper). Audio flows as
// binary frames (raw PCM/opus chunks); control and transcripts flow as the JSON
// messages below. Both ends import these types so the wire contract is pinned.

import { z } from "zod";

export type SttLatency = "minimal" | "low" | "medium" | "high" | "xhigh";

/** Client -> server control messages (audio itself is sent as binary frames). */
export interface SttStartMessage {
  type: "start";
  /** Sample rate (Hz) of the binary audio frames the client will send. */
  sampleRate: number;
  /** Latency/accuracy knob passed through to the upstream model. */
  latency?: SttLatency;
}
export interface SttStopMessage {
  type: "stop";
}
export type SttClientMessage = SttStartMessage | SttStopMessage;

export const sttLatencySchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/**
 * Zod schema mirroring SttClientMessage, kept in lockstep with the interfaces
 * above. The bridge validates the parsed control frame with this so a malformed or
 * non-numeric `sampleRate` (e.g. `{"sampleRate":"fast"}`) is rejected -- an
 * unchecked sampleRate would yield NaN audio-seconds and corrupt the spend meter.
 * `sampleRate` must be a finite, positive number (Hz).
 */
export const sttStartMessageSchema = z.object({
  type: z.literal("start"),
  sampleRate: z.number().finite().positive(),
  latency: sttLatencySchema.optional(),
});
export const sttStopMessageSchema = z.object({ type: z.literal("stop") });
export const sttClientMessageSchema = z.discriminatedUnion("type", [
  sttStartMessageSchema,
  sttStopMessageSchema,
]);

// Compile-time guard that schema and interfaces stay consistent in both directions.
type AssertExtends<A extends B, B> = true;
type _SttFwd = AssertExtends<
  z.infer<typeof sttClientMessageSchema>,
  SttClientMessage
>;
type _SttBwd = AssertExtends<
  SttClientMessage,
  z.infer<typeof sttClientMessageSchema>
>;

/** Server -> client messages. */
export interface SttReadyMessage {
  type: "ready"; // upstream socket is OPEN; the client may stream audio
}
export interface SttInterimMessage {
  type: "interim";
  text: string;
}
export interface SttFinalMessage {
  type: "final";
  text: string;
  /** Audio seconds this utterance consumed, for the per-document spend meter. */
  seconds: number;
}
export interface SttErrorMessage {
  type: "error";
  message: string;
}
/** Why the server closed the session (cost caps and lifecycle). */
export type SttCloseReason =
  | "done"
  | "idle_timeout"
  | "max_duration"
  | "byte_budget"
  | "unauthenticated"
  | "server_error";
export interface SttClosedMessage {
  type: "closed";
  reason: SttCloseReason;
}
export type SttServerMessage =
  | SttReadyMessage
  | SttInterimMessage
  | SttFinalMessage
  | SttErrorMessage
  | SttClosedMessage;
