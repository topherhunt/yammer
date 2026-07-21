import type { SttServerMessage } from "@yammer/shared";
import { WS_OPEN, type WebSocketLike } from "./ws-stt";

// A fake WebSocket for unit-testing WsSttClient: it records everything the client
// sent and lets tests drive the server side (open, ready, transcripts, close).

const WS_CONNECTING = 0;
const WS_CLOSED = 3;

export class FakeWebSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = WS_CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  /** JSON control messages the client sent (parsed). */
  readonly sentText: string[] = [];
  /** Binary audio frames the client sent, as ArrayBuffers. */
  readonly sentBinary: ArrayBuffer[] = [];
  closed = false;

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === "string") {
      this.sentText.push(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.sentBinary.push(data);
      return;
    }
    const view = data as ArrayBufferView;
    this.sentBinary.push(
      view.buffer.slice(
        view.byteOffset,
        view.byteOffset + view.byteLength,
      ) as ArrayBuffer,
    );
  }

  close(): void {
    this.closed = true;
    this.readyState = WS_CLOSED;
    this.onclose?.();
  }

  // -- server-side drivers --

  /** Transition to OPEN and fire onopen (client sends its `start` here). */
  open(): void {
    this.readyState = WS_OPEN;
    this.onopen?.();
  }

  /** Deliver a protocol message from the server to the client. */
  server(msg: SttServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  error(): void {
    this.onerror?.();
  }

  /** Control frames the client sent, parsed for assertions. */
  get sentControl(): unknown[] {
    return this.sentText.map((t) => JSON.parse(t));
  }
}
