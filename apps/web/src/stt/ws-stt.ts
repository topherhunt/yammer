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
}

export class WsSttClient implements SttProvider {
  private socket: WebSocketLike | null = null;
  private ready = false;
  private speaking = false;
  /** Frames captured before `ready`; flushed once the upstream is OPEN so the
   * leading edge of an utterance is not lost (and early frames don't tear the
   * connection down -- see plan.md voice security backlog). */
  private prebuffer: Int16Array[] = [];

  private interimCbs: Array<(text: string) => void> = [];
  private finalCbs: Array<(text: string) => void> = [];
  private finalDetailedCbs: Array<(text: string, seconds: number) => void> = [];
  private vadCbs: Array<(speaking: boolean) => void> = [];

  private readonly maxPrebufferFrames: number;

  constructor(private readonly opts: WsSttOptions) {
    this.maxPrebufferFrames = opts.maxPrebufferFrames ?? 200;
    opts.mic.onFrame((frame) => this.onMicFrame(frame));
    opts.vad.onSpeechStart(() => {
      this.speaking = true;
      this.emitVad(true);
    });
    opts.vad.onSpeechEnd(() => {
      this.speaking = false;
      this.emitVad(false);
    });
  }

  start(): void {
    if (this.socket) return; // already streaming
    this.ready = false;
    this.speaking = false;
    this.prebuffer = [];

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
    socket.onerror = () => this.opts.onError?.("STT socket error");
    socket.onclose = () => {
      this.socket = null;
      this.ready = false;
    };

    // Begin capturing immediately; frames are buffered until `ready`.
    void this.opts.mic.start().catch((err) =>
      this.opts.onError?.(`Mic capture failed: ${errMessage(err)}`),
    );
    void this.opts.vad.start().catch((err) =>
      this.opts.onError?.(`VAD start failed: ${errMessage(err)}`),
    );
  }

  stop(): void {
    const socket = this.socket;
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
