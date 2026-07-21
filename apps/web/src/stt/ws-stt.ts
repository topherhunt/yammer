import type { SttProvider } from "@yammer/shared";
import type {
  SttClientMessage,
  SttLatency,
  SttServerMessage,
} from "@yammer/shared";
import type { MicCapture, VadDetector } from "../voice/interfaces";

// The WebSocket-backed SttProvider. It opens /api/stt, speaks the shared wire
// protocol (packages/shared/src/stt.ts), and streams mic audio as binary frames
// -- gated by the VAD so pure silence is never streamed or charged. Interim and
// final transcripts surface through the SttProvider callbacks; `onFinalDetailed`
// additionally carries the audio-seconds the frozen interface can't.
//
// The mic (getUserMedia + audio graph), the VAD model, and the raw WebSocket are
// all injected behind interfaces, so this whole client is unit-tested with fakes
// and never touches real hardware or a real socket.

/** The minimal WebSocket surface we use, so tests can supply a fake. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: (() => void) | null;
}

export const WS_OPEN = 1;

export interface WsSttOptions {
  socketFactory: () => WebSocketLike;
  mic: MicCapture;
  vad: VadDetector;
  latency?: SttLatency;
  /** The frozen SttProvider has no error channel; surface protocol/socket errors
   * here (the store already funnels these into the chat log). */
  onError?: (message: string) => void;
  /** Cap on frames buffered before the server signals `ready`, so a slow upstream
   * can't grow memory without bound. Oldest frames drop past the cap. */
  maxPrebufferFrames?: number;
  /** Bounded auto-reconnect on an UNEXPECTED socket drop. Cap on retries before
   * we give up and surface a persistent error (default 5). An intentional stop()
   * never reconnects. */
  maxReconnectAttempts?: number;
  /** Backoff before the Nth (0-based) reconnect attempt, in ms. Default is a
   * bounded exponential; overridable so tests can drop the wait. */
  reconnectDelayMs?: (attempt: number) => number;
}

export class WsSttClient implements SttProvider {
  private socket: WebSocketLike | null = null;
  private ready = false;
  private speaking = false;
  /** Samples streamed upstream since the last commit. OpenAI rejects a commit of
   * under ~100 ms of audio, so end-of-speech only commits once enough was sent. */
  private sentSamplesSinceCommit = 0;
  /** Frames captured before `ready`; flushed once the upstream is OPEN so the
   * leading edge of an utterance is not lost (and early frames don't tear the
   * connection down -- see plan.md voice security backlog). */
  private prebuffer: Int16Array[] = [];

  private interimCbs: Array<(text: string) => void> = [];
  private finalCbs: Array<(text: string) => void> = [];
  private finalDetailedCbs: Array<(text: string, seconds: number) => void> = [];
  private vadCbs: Array<(speaking: boolean) => void> = [];

  private readonly maxPrebufferFrames: number;

  /** True once stop() was called intentionally -- suppresses auto-reconnect. A
   * fresh start() clears it. */
  private stopping = false;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private reconnectAttempts = 0;
  private reconnectScheduled = false;
  private reconnectHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: WsSttOptions) {
    this.maxPrebufferFrames = opts.maxPrebufferFrames ?? 200;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
    this.reconnectDelayMs =
      opts.reconnectDelayMs ?? ((attempt) => Math.min(8000, 250 * 2 ** attempt));
    opts.mic.onFrame((frame) => this.onMicFrame(frame));
    opts.vad.onSpeechStart(() => {
      this.speaking = true;
      this.emitVad(true);
    });
    opts.vad.onSpeechEnd(() => {
      this.speaking = false;
      this.emitVad(false);
      // End-of-speech: tell the server to commit the buffered utterance so the
      // upstream transcribes it and emits a final. Without this the upstream (with
      // server-VAD disabled) never endpoints and no final is ever produced.
      this.commitUtterance();
    });
  }

  /** Open the STT session and confirm capture. The socket + audio graph come up;
   * the returned promise resolves only once mic + VAD capture is CONFIRMED and
   * rejects if getUserMedia/permission is denied -- so the caller never enters a
   * lying "listening" state before the mic is actually live. */
  start(): Promise<void> {
    if (this.socket) return Promise.resolve(); // already streaming
    this.stopping = false;
    this.ready = false;
    this.speaking = false;
    this.sentSamplesSinceCommit = 0;
    this.prebuffer = [];
    this.reconnectAttempts = 0;
    this.reconnectScheduled = false;

    this.openSocket();

    // Confirm capture before reporting success. A denial tears the half-open
    // session down and propagates, rather than leaving a dead mic that still
    // says "Listening".
    return Promise.all([this.opts.mic.start(), this.opts.vad.start()])
      .then(() => undefined)
      .catch((err) => {
        this.stop();
        throw new Error(`Microphone capture failed: ${errMessage(err)}`);
      });
  }

  /** Open (or re-open) the raw socket and wire its lifecycle. Reused by start()
   * and by the auto-reconnect path, so a reconnect re-sends the `start` control
   * message (via onopen) and resumes streaming without touching the mic/VAD,
   * which stay running across a drop. */
  private openSocket(): void {
    const socket = this.opts.socketFactory();
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      const start: SttClientMessage = {
        type: "start",
        sampleRate: this.opts.mic.sampleRate,
        ...(this.opts.latency ? { latency: this.opts.latency } : {}),
      };
      socket.send(JSON.stringify(start));
    };
    socket.onmessage = (ev) => this.onServerMessage(ev.data);
    // An unexpected error or close must surface AND reconnect (both funnel to
    // handleDrop, which de-dupes so a paired error+close schedules one reconnect).
    socket.onerror = () => this.handleDrop();
    socket.onclose = () => {
      this.socket = null;
      this.ready = false;
      this.handleDrop();
    };
  }

  /** An UNEXPECTED socket drop (error/close not initiated by stop()): surface it
   * and schedule a bounded, backed-off reconnect. When retries are exhausted,
   * surface a clear persistent error and give up. */
  private handleDrop(): void {
    if (this.stopping) return; // intentional stop -- never reconnect
    if (this.reconnectScheduled) return; // a paired error+close -- handle once
    this.socket = null;
    this.ready = false;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.opts.onError?.(
        `STT connection lost and could not be restored after ${this.maxReconnectAttempts} attempts. Please tap the mic to restart listening.`,
      );
      return;
    }

    const attempt = this.reconnectAttempts;
    this.reconnectAttempts += 1;
    this.reconnectScheduled = true;
    this.opts.onError?.("STT connection lost -- reconnecting…");
    this.reconnectHandle = setTimeout(() => {
      this.reconnectHandle = null;
      this.reconnectScheduled = false;
      if (this.stopping || this.socket) return;
      this.openSocket(); // mic/VAD still running; frames re-buffer until `ready`
    }, this.reconnectDelayMs(attempt));
  }

  stop(): void {
    const socket = this.socket;
    this.stopping = true;
    this.reconnectScheduled = false;
    if (this.reconnectHandle !== null) {
      clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    this.opts.mic.stop();
    this.opts.vad.stop();
    this.speaking = false;
    this.prebuffer = [];
    if (socket) {
      if (socket.readyState === WS_OPEN) {
        const stop: SttClientMessage = { type: "stop" };
        socket.send(JSON.stringify(stop));
      }
      socket.close();
    }
    this.socket = null;
    this.ready = false;
  }

  onInterim(cb: (text: string) => void): void {
    this.interimCbs.push(cb);
  }
  onFinal(cb: (text: string) => void): void {
    this.finalCbs.push(cb);
  }
  /** Beyond SttProvider: the final transcript with its audio-seconds. */
  onFinalDetailed(cb: (text: string, seconds: number) => void): void {
    this.finalDetailedCbs.push(cb);
  }
  onVad(cb: (speaking: boolean) => void): void {
    this.vadCbs.push(cb);
  }

  private onMicFrame(frame: Int16Array): void {
    if (!this.ready) {
      // Buffer the leading edge; drop oldest past the cap.
      this.prebuffer.push(frame);
      if (this.prebuffer.length > this.maxPrebufferFrames) this.prebuffer.shift();
      return;
    }
    // Once streaming, only forward audio while the VAD reports speech, so pure
    // silence is never streamed or billed.
    if (this.speaking) this.sendFrame(frame);
  }

  private sendFrame(frame: Int16Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) return;
    // Send the exact bytes of this frame (never the whole shared backing buffer).
    socket.send(
      frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength,
      ),
    );
    this.sentSamplesSinceCommit += frame.length;
  }

  /** On end-of-speech, commit the buffered utterance so the upstream transcribes
   * it. Guarded: a commit of under ~120 ms of audio is rejected by OpenAI
   * ("buffer too small"), so a fleeting VAD blip that streamed almost nothing is
   * dropped rather than committed. */
  private commitUtterance(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN || !this.ready) return;
    const minSamples = this.opts.mic.sampleRate * 0.12;
    if (this.sentSamplesSinceCommit < minSamples) return;
    this.sentSamplesSinceCommit = 0;
    const commit: SttClientMessage = { type: "commit" };
    socket.send(JSON.stringify(commit));
  }

  private onServerMessage(data: unknown): void {
    if (typeof data !== "string") return; // transcripts/control are JSON text
    let msg: SttServerMessage;
    try {
      msg = JSON.parse(data) as SttServerMessage;
    } catch {
      this.opts.onError?.("Malformed STT server message");
      return;
    }
    switch (msg.type) {
      case "ready":
        this.ready = true;
        // A confirmed (re)connection refreshes the retry budget, so a later drop
        // gets the full reconnect allowance again.
        this.reconnectAttempts = 0;
        this.flushPrebuffer();
        break;
      case "interim":
        for (const cb of this.interimCbs) cb(msg.text);
        break;
      case "final":
        for (const cb of this.finalCbs) cb(msg.text);
        for (const cb of this.finalDetailedCbs) cb(msg.text, msg.seconds);
        break;
      case "error":
        this.opts.onError?.(msg.message);
        break;
      case "closed":
        this.opts.onError?.(`STT session closed: ${msg.reason}`);
        break;
    }
  }

  private flushPrebuffer(): void {
    for (const frame of this.prebuffer) this.sendFrame(frame);
    this.prebuffer = [];
  }

  private emitVad(speaking: boolean): void {
    for (const cb of this.vadCbs) cb(speaking);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
