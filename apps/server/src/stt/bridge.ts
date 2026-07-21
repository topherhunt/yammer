// STT proxy bridge (plan.md sec 7 + the sec 16 voice-phase hardening). The browser
// streams mic audio to us; we relay it to OpenAI realtime transcription over a
// server-side socket and relay transcripts back. The OpenAI socket NEVER reaches
// the browser (the API key stays server-side). The bridge is written against an
// abstract upstream + client channel so tests inject fakes -- no real sockets, no
// network, no spend. The actual HTTP upgrade is wired in stt/upgrade.ts.
//
// The bridge speaks the shared wire protocol (@yammer/shared/stt): the client sends
// a `start` control message, then binary audio frames, then `stop`; the server
// replies `ready` / `interim` / `final` / `error` / `closed`. It also enforces the
// deferred cost + lifecycle hardening: an auth gate (no userId => no upstream, no
// spend), buffer-until-open (early audio never tears down the socket), and the cost
// caps (max duration, idle timeout, cumulative-byte budget, oversized-frame reject,
// per-user concurrency) -- each closing BOTH sockets with the matching close reason.

import type {
  SttCloseReason,
  SttLatency,
  SttServerMessage,
} from "@yammer/shared";
import { sttClientMessageSchema } from "@yammer/shared";

/** The server-side connection to OpenAI realtime transcription. */
export interface SttUpstream {
  /** Send one raw audio frame (PCM bytes); the adapter wraps it for the wire. */
  send(audio: Uint8Array): void;
  /** Commit the audio buffered upstream so far, forcing transcription of the
   * current utterance and a `...transcription.completed` (final) event. Called
   * when the client signals end-of-speech (see SttCommitMessage). */
  commit(): void;
  close(code?: number): void;
  /** Fires when the upstream socket reaches OPEN and can accept audio. */
  onOpen(cb: () => void): void;
  onMessage(cb: (data: unknown) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
}

/** The browser-facing channel the bridge writes protocol messages to. */
export interface SttClientChannel {
  send(message: SttServerMessage): void;
  close(code?: number): void;
}

/** Opens a fresh upstream for a session, parameterized by the client's `start`. */
export type OpenSttUpstream = (params: {
  sampleRate: number;
  latency?: SttLatency;
}) => SttUpstream;

/** Handlers the transport layer calls when the client sends data or disconnects. */
export interface SttBridge {
  /** `isBinary` distinguishes audio frames (true) from JSON control frames. */
  onClientMessage(data: unknown, isBinary: boolean): void;
  onClientClose(): void;
}

/** Cost + lifecycle caps. All configurable via env (see sttLimitsFromEnv). */
export interface SttLimits {
  /** Hard ceiling on total session wall-clock; closes with `max_duration`. */
  maxSessionMs: number;
  /** No audio for this long closes with `idle_timeout`. */
  idleMs: number;
  /** Cumulative audio bytes across the session; closes with `byte_budget`. */
  maxTotalBytes: number;
  /** A single audio frame larger than this closes with `byte_budget`. */
  maxFrameBytes: number;
  /** Max simultaneous STT sockets per user (see SttConcurrencyRegistry). */
  maxPerUser: number;
}

/** Tracks live sockets per user so a single user can't fan out unbounded spend. */
export interface SttConcurrencyRegistry {
  /** Reserve a slot for `userId`; false if the user is already at the cap. */
  tryAcquire(userId: string): boolean;
  /** Release a previously acquired slot. */
  release(userId: string): void;
}

export function createConcurrencyRegistry(
  maxPerUser: number,
): SttConcurrencyRegistry {
  const counts = new Map<string, number>();
  return {
    tryAcquire(userId) {
      const current = counts.get(userId) ?? 0;
      if (current >= maxPerUser) return false;
      counts.set(userId, current + 1);
      return true;
    },
    release(userId) {
      const current = counts.get(userId) ?? 0;
      if (current <= 1) counts.delete(userId);
      else counts.set(userId, current - 1);
    },
  };
}

export interface SttBridgeConfig {
  client: SttClientChannel;
  /** Authenticated user id, or null for an unauthenticated upgrade (refused). */
  userId: string | null;
  openUpstream: OpenSttUpstream;
  limits: SttLimits;
  concurrency: SttConcurrencyRegistry;
}

// PCM16 mono: two bytes per sample. Used to meter audio-seconds from byte counts
// for the per-document spend meter (SttFinalMessage.seconds).
const BYTES_PER_SAMPLE = 2;

/** A bridge whose handlers are inert (used after a refused/closed session). */
const INERT_BRIDGE: SttBridge = {
  onClientMessage() {
    /* session already closed */
  },
  onClientClose() {
    /* session already closed */
  },
};

/**
 * Wire a client channel to an upstream that is opened only after the client sends
 * `start` (and only for an authenticated user). Audio flows client -> upstream,
 * transcripts flow upstream -> client, and any close/error/cap on either side tears
 * down both exactly once with the matching close reason.
 */
export function createSttBridge(config: SttBridgeConfig): SttBridge {
  const { client, userId, openUpstream, limits, concurrency } = config;

  let closed = false;
  let acquired = false;
  let upstream: SttUpstream | null = null;
  let upstreamOpen = false;
  let started = false;
  let sampleRate = 0;

  // Audio received before the upstream socket is OPEN is buffered here and flushed
  // on open -- early frames must never throw or tear the connection down.
  const pending: Uint8Array[] = [];
  let totalBytes = 0;
  let bytesSinceFinal = 0;
  // A commit that arrived before the upstream was OPEN: the buffered audio is
  // flushed on open, then this fires the deferred commit so no utterance is lost.
  let pendingCommit = false;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let durationTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (durationTimer) clearTimeout(durationTimer);
    idleTimer = null;
    durationTimer = null;
  };

  const send = (message: SttServerMessage) => {
    try {
      client.send(message);
    } catch {
      /* client already gone */
    }
  };

  const closeBoth = (reason: SttCloseReason) => {
    if (closed) return;
    closed = true;
    clearTimers();
    if (acquired && userId) {
      concurrency.release(userId);
      acquired = false;
    }
    // Tell the client why before tearing the socket down.
    send({ type: "closed", reason });
    if (upstream) {
      try {
        upstream.close();
      } catch {
        /* already closed */
      }
    }
    try {
      client.close();
    } catch {
      /* already closed */
    }
  };

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => closeBoth("idle_timeout"), limits.idleMs);
  };

  // -- Auth gate: refuse before opening any upstream (no upstream => no spend). ---
  if (userId === null) {
    closeBoth("unauthenticated");
    return INERT_BRIDGE;
  }
  // -- Concurrency cap: refuse a user's (N+1)th socket, also before any upstream. -
  // The shared close-reason enum has no dedicated concurrency reason, so this maps
  // to `server_error` (the catch-all) -- documented, not a silent drop.
  if (!concurrency.tryAcquire(userId)) {
    closeBoth("server_error");
    return INERT_BRIDGE;
  }
  acquired = true;

  // Session-wide caps start ticking the moment the socket is up: a client that
  // connects and then goes silent still gets reaped.
  durationTimer = setTimeout(() => closeBoth("max_duration"), limits.maxSessionMs);
  resetIdle();

  const onUpstreamOpen = () => {
    if (closed) return;
    upstreamOpen = true;
    // Flush everything buffered before OPEN, THEN signal ready.
    for (const frame of pending) {
      upstream?.send(frame);
    }
    pending.length = 0;
    // A commit signalled while we were still buffering applies now that the
    // just-flushed audio is upstream.
    if (pendingCommit) {
      pendingCommit = false;
      upstream?.commit();
    }
    send({ type: "ready" });
  };

  const onUpstreamMessage = (data: unknown) => {
    if (closed) return;
    const event = parseUpstreamEvent(data);
    if (event.kind === "interim") {
      send({ type: "interim", text: event.text });
    } else if (event.kind === "final") {
      const seconds =
        sampleRate > 0 ? bytesSinceFinal / (sampleRate * BYTES_PER_SAMPLE) : 0;
      bytesSinceFinal = 0;
      send({ type: "final", text: event.text, seconds });
    } else if (event.kind === "error") {
      send({ type: "error", message: event.message });
      closeBoth("server_error");
    }
    // Any other upstream event is transcription bookkeeping we don't surface.
  };

  const handleControl = (data: unknown) => {
    const text = toText(data);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      send({ type: "error", message: "malformed control message" });
      closeBoth("server_error");
      return;
    }

    // Validate the control message BEFORE trusting any field. An unchecked
    // sampleRate (e.g. {"sampleRate":"fast"} -> NaN) would corrupt audio-seconds
    // metering and thus the spend meter, so a malformed/absent sampleRate is
    // rejected here with a clear error and no upstream is ever opened.
    const parsed = sttClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      send({ type: "error", message: "invalid control message" });
      closeBoth("server_error");
      return;
    }
    const message = parsed.data;

    if (message.type === "start") {
      if (started) return; // a second start is a no-op; the first one owns the session
      started = true;
      sampleRate = message.sampleRate;
      const up = openUpstream({ sampleRate, latency: message.latency });
      upstream = up;
      up.onOpen(onUpstreamOpen);
      up.onMessage(onUpstreamMessage);
      // An upstream that closes on its own (before our `stop`) is unexpected: our
      // own teardown flips `closed` first, so reaching here means a dropped socket.
      up.onClose(() => closeBoth("server_error"));
      up.onError((err) => {
        send({ type: "error", message: upstreamErrorMessage(err) });
        closeBoth("server_error");
      });
      return;
    }

    if (message.type === "commit") {
      // End-of-speech: force the upstream to transcribe what it has buffered.
      // Before start / before the upstream is OPEN, remember to commit once the
      // buffered leading edge has been flushed (onUpstreamOpen).
      if (!started || !upstream) return;
      if (upstreamOpen) upstream.commit();
      else pendingCommit = true;
      return;
    }

    // The discriminated-union schema guarantees the only remaining case is `stop`.
    closeBoth("done");
  };

  const handleAudio = (data: unknown) => {
    const frame = toUint8Array(data);
    // Oversized single frame: reject the whole session (byte-cost protection).
    if (frame.byteLength > limits.maxFrameBytes) {
      closeBoth("byte_budget");
      return;
    }
    totalBytes += frame.byteLength;
    if (totalBytes > limits.maxTotalBytes) {
      closeBoth("byte_budget");
      return;
    }
    bytesSinceFinal += frame.byteLength;
    resetIdle();

    if (upstream && upstreamOpen) {
      upstream.send(frame);
    } else {
      // Buffer until the upstream is OPEN (fixes the "early audio tears down the
      // connection" bug); flushed by onUpstreamOpen.
      pending.push(frame);
    }
  };

  return {
    onClientMessage(data, isBinary) {
      if (closed) return;
      if (isBinary) handleAudio(data);
      else handleControl(data);
    },
    onClientClose() {
      closeBoth("done");
    },
  };
}

// -- Upstream event mapping ---------------------------------------------------

type UpstreamEvent =
  | { kind: "interim"; text: string }
  | { kind: "final"; text: string }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

/**
 * Map an OpenAI realtime transcription event to our neutral shape. Partials arrive
 * as `...transcription.delta` (incremental `delta`), finals as
 * `...transcription.completed` (full `transcript`). Everything else is ignored.
 */
export function parseUpstreamEvent(data: unknown): UpstreamEvent {
  let obj: Record<string, unknown>;
  if (typeof data === "string") {
    try {
      obj = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return { kind: "ignore" };
    }
  } else if (data && typeof data === "object") {
    obj = data as Record<string, unknown>;
  } else {
    return { kind: "ignore" };
  }

  const type = obj.type;
  if (typeof type !== "string") return { kind: "ignore" };

  if (type === "error" || type.endsWith(".error")) {
    const err = obj.error;
    const message =
      err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : typeof obj.message === "string"
          ? obj.message
          : "upstream error";
    return { kind: "error", message };
  }

  if (type.endsWith("transcription.delta")) {
    return typeof obj.delta === "string"
      ? { kind: "interim", text: obj.delta }
      : { kind: "ignore" };
  }

  if (type.endsWith("transcription.completed")) {
    return typeof obj.transcript === "string"
      ? { kind: "final", text: obj.transcript }
      : { kind: "ignore" };
  }

  return { kind: "ignore" };
}

function upstreamErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "upstream error";
}

// -- Wire-frame normalization -------------------------------------------------
// The `ws` transport hands us Buffer | ArrayBuffer | Buffer[] for both text and
// binary frames; normalize to the shape the bridge logic wants.

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  throw new Error("Unsupported control-frame payload type");
}

function toUint8Array(data: unknown): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error("Unsupported audio-frame payload type");
}

// -- Env-configured limits ----------------------------------------------------

/** Parse a positive-integer env var, or fall back to `fallback`. Fails loudly on a
 * present-but-invalid value rather than silently using the default. */
function positiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * STT cost/lifecycle caps from env, with defaults tuned for gpt-realtime-whisper
 * (~$0.017/min, PCM16 @ ~48 KB/s). Defaults: ~10 min max session, 30 s idle,
 * 32 MiB (~11 min of audio) byte budget, 1 MiB max frame, 3 sockets/user.
 */
export function sttLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): SttLimits {
  return {
    maxSessionMs: positiveIntEnv(env, "STT_MAX_SESSION_MS", 10 * 60 * 1000),
    idleMs: positiveIntEnv(env, "STT_IDLE_TIMEOUT_MS", 30 * 1000),
    maxTotalBytes: positiveIntEnv(env, "STT_MAX_TOTAL_BYTES", 32 * 1024 * 1024),
    maxFrameBytes: positiveIntEnv(env, "STT_MAX_FRAME_BYTES", 1024 * 1024),
    maxPerUser: positiveIntEnv(env, "STT_MAX_SOCKETS_PER_USER", 3),
  };
}
