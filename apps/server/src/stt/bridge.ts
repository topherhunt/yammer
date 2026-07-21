// STT proxy bridge (plan.md sec 7). The browser streams mic audio to us; we relay
// it to OpenAI realtime transcription over a server-side socket and relay
// transcripts back. The OpenAI socket NEVER reaches the browser (the API key stays
// server-side). The bridge is written against an abstract upstream so tests inject
// a fake -- no real sockets, no network, no spend. Wiring the actual HTTP upgrade
// onto Hono is deferred to the voice phase (needs a node-ws adapter dep).

/** The server-side connection to OpenAI realtime transcription. */
export interface SttUpstream {
  send(data: unknown): void;
  close(code?: number): void;
  onMessage(cb: (data: unknown) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
}

/** The browser-facing socket the bridge writes transcripts to. */
export interface SttClientChannel {
  send(data: unknown): void;
  close(code?: number): void;
}

/** Handlers the transport layer calls when the client sends audio or disconnects. */
export interface SttBridge {
  onClientMessage(data: unknown): void;
  onClientClose(): void;
}

/**
 * Wire a client channel to a freshly opened upstream: audio flows
 * client -> upstream, transcripts flow upstream -> client, and a close/error on
 * either side tears down both exactly once.
 */
export function createSttBridge(
  client: SttClientChannel,
  openUpstream: () => SttUpstream,
): SttBridge {
  const upstream = openUpstream();
  let closed = false;

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    try {
      upstream.close();
    } catch {
      /* already closed */
    }
    try {
      client.close();
    } catch {
      /* already closed */
    }
  };

  upstream.onMessage((data) => {
    if (!closed) client.send(data);
  });
  upstream.onClose(closeBoth);
  upstream.onError(closeBoth);

  return {
    onClientMessage(data) {
      if (!closed) upstream.send(data);
    },
    onClientClose() {
      closeBoth();
    },
  };
}

export interface OpenAiUpstreamOptions {
  apiKey: string;
  model?: string;
}

/**
 * The real upstream factory: a WebSocket to OpenAI realtime transcription, adapted
 * to SttUpstream. Auth rides the subprotocol (OpenAI's documented browser/edge
 * pattern) so no custom headers are needed. Guarded behind a runtime WebSocket
 * check; this path is exercised only in the live voice build, never in tests.
 */
export function openOpenAiUpstream(opts: OpenAiUpstreamOptions): SttUpstream {
  const WS = (globalThis as { WebSocket?: unknown }).WebSocket as
    | (new (url: string, protocols?: string[]) => {
        send(data: unknown): void;
        close(code?: number): void;
        addEventListener(type: string, cb: (ev: unknown) => void): void;
      })
    | undefined;
  if (!WS) {
    throw new Error(
      "Global WebSocket unavailable -- Node 21+ (or a ws polyfill) is required for the STT upstream.",
    );
  }
  const model = opts.model ?? "gpt-realtime-whisper";
  const socket = new WS(
    `wss://api.openai.com/v1/realtime?intent=transcription&model=${encodeURIComponent(model)}`,
    [
      "realtime",
      `openai-insecure-api-key.${opts.apiKey}`,
      "openai-beta.realtime-v1",
    ],
  );

  return {
    send: (data) => socket.send(data),
    close: (code) => socket.close(code),
    onMessage: (cb) =>
      socket.addEventListener("message", (ev) =>
        cb((ev as { data: unknown }).data),
      ),
    onClose: (cb) => socket.addEventListener("close", () => cb()),
    onError: (cb) => socket.addEventListener("error", (ev) => cb(ev)),
  };
}
