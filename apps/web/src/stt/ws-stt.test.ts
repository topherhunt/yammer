import { describe, expect, it } from "vitest";
import { FakeMicCapture, FakeVadDetector } from "../voice/fakes";
import { FakeWebSocket } from "./fake-socket";
import { WsSttClient } from "./ws-stt";

// WsSttClient speaks the shared wire protocol over an injected socket + mic + VAD.
// Everything is faked -- no real WebSocket, mic, or model.

function makeClient(opts: { maxReconnectAttempts?: number } = {}) {
  let socket: FakeWebSocket | null = null;
  let socketsCreated = 0;
  const mic = new FakeMicCapture(16000);
  const vad = new FakeVadDetector();
  const errors: string[] = [];
  const client = new WsSttClient({
    socketFactory: () => {
      socket = new FakeWebSocket();
      socketsCreated += 1;
      return socket;
    },
    mic,
    vad,
    latency: "low",
    onError: (m) => errors.push(m),
    // Deterministic + instant reconnect scheduling; tests flush a macrotask.
    reconnectDelayMs: () => 0,
    ...(opts.maxReconnectAttempts !== undefined
      ? { maxReconnectAttempts: opts.maxReconnectAttempts }
      : {}),
  });
  return {
    client,
    mic,
    vad,
    errors,
    get socketsCreated() {
      return socketsCreated;
    },
    get socket(): FakeWebSocket {
      if (!socket) throw new Error("socket not created yet");
      return socket;
    },
  };
}

/** Let a `reconnectDelayMs: () => 0` timer fire. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const frame = (fill: number) => Int16Array.from([fill, fill, fill]);

describe("session start", () => {
  it("opens a socket, starts mic+VAD, and sends the start control message on open", () => {
    const h = makeClient();
    h.client.start();
    expect(h.mic.running).toBe(true);
    expect(h.vad.started).toBe(1);
    expect(h.socket.binaryType).toBe("arraybuffer");

    h.socket.open();
    expect(h.socket.sentControl).toEqual([
      { type: "start", sampleRate: 16000, latency: "low" },
    ]);
  });
});

describe("audio gating", () => {
  it("buffers frames until the server is ready, then flushes them", () => {
    const h = makeClient();
    h.client.start();
    h.socket.open();

    // Speaking, but the upstream is not ready yet: nothing streamed.
    h.vad.emitSpeechStart();
    h.mic.emitFrame(frame(1));
    h.mic.emitFrame(frame(2));
    expect(h.socket.sentBinary).toHaveLength(0);

    // Ready: the buffered leading edge is flushed.
    h.socket.server({ type: "ready" });
    expect(h.socket.sentBinary).toHaveLength(2);
  });

  it("streams audio only while the VAD reports speech (silence is not charged)", () => {
    const h = makeClient();
    h.client.start();
    h.socket.open();
    h.socket.server({ type: "ready" });

    // Silent: dropped.
    h.mic.emitFrame(frame(1));
    expect(h.socket.sentBinary).toHaveLength(0);

    // Speaking: streamed.
    h.vad.emitSpeechStart();
    h.mic.emitFrame(frame(2));
    expect(h.socket.sentBinary).toHaveLength(1);
    // The exact PCM16 bytes of the frame were sent.
    expect(new Int16Array(h.socket.sentBinary[0]!)).toEqual(frame(2));

    // Back to silence: dropped again.
    h.vad.emitSpeechEnd();
    h.mic.emitFrame(frame(3));
    expect(h.socket.sentBinary).toHaveLength(1);
  });

  it("commits the utterance on end-of-speech, but only once enough audio streamed", () => {
    const h = makeClient(); // FakeMicCapture sampleRate 16000 -> 1920-sample floor
    h.client.start();
    h.socket.open();
    h.socket.server({ type: "ready" });

    // A fleeting blip streamed almost nothing: end-of-speech must NOT commit
    // (OpenAI rejects a sub-100ms commit).
    h.vad.emitSpeechStart();
    h.mic.emitFrame(frame(1)); // 3 samples
    h.vad.emitSpeechEnd();
    expect(h.socket.sentControl).not.toContainEqual({ type: "commit" });

    // A real utterance (>=120ms @ 16kHz => >=1920 samples) commits on speech-end
    // so the upstream transcribes it and returns a final.
    h.vad.emitSpeechStart();
    h.mic.emitFrame(new Int16Array(2000));
    h.vad.emitSpeechEnd();
    expect(h.socket.sentControl.at(-1)).toEqual({ type: "commit" });
  });

  it("surfaces VAD speech edges through onVad", () => {
    const h = makeClient();
    const seen: boolean[] = [];
    h.client.onVad((s) => seen.push(s));
    h.client.start();
    h.vad.emitSpeechStart();
    h.vad.emitSpeechEnd();
    expect(seen).toEqual([true, false]);
  });
});

describe("transcripts", () => {
  it("delivers interim text and final text + audio-seconds", () => {
    const h = makeClient();
    const interims: string[] = [];
    const finals: string[] = [];
    const detailed: Array<{ text: string; seconds: number }> = [];
    h.client.onInterim((t) => interims.push(t));
    h.client.onFinal((t) => finals.push(t));
    h.client.onFinalDetailed((text, seconds) => detailed.push({ text, seconds }));

    h.client.start();
    h.socket.open();
    h.socket.server({ type: "ready" });
    h.socket.server({ type: "interim", text: "hel" });
    h.socket.server({ type: "final", text: "hello", seconds: 1.25 });

    expect(interims).toEqual(["hel"]);
    expect(finals).toEqual(["hello"]);
    expect(detailed).toEqual([{ text: "hello", seconds: 1.25 }]);
  });

  it("routes server error + closed messages to onError", () => {
    const h = makeClient();
    h.client.start();
    h.socket.open();
    h.socket.server({ type: "error", message: "upstream boom" });
    h.socket.server({ type: "closed", reason: "byte_budget" });
    expect(h.errors).toEqual(["upstream boom", "STT session closed: byte_budget"]);
  });
});

describe("session stop", () => {
  it("sends the stop control message, closes the socket, and releases mic+VAD", () => {
    const h = makeClient();
    h.client.start();
    h.socket.open();
    const socket = h.socket;

    h.client.stop();
    expect(socket.sentControl.at(-1)).toEqual({ type: "stop" });
    expect(socket.closed).toBe(true);
    expect(h.mic.running).toBe(false);
    expect(h.vad.stopped).toBe(1);
  });
});

describe("capture confirmation", () => {
  it("resolves start() once mic + VAD capture is confirmed", async () => {
    const h = makeClient();
    await expect(h.client.start()).resolves.toBeUndefined();
    expect(h.mic.running).toBe(true);
  });

  it("rejects start() and tears the session down when the mic is denied", async () => {
    let socket: FakeWebSocket | null = null;
    let created = 0;
    const mic = new FakeMicCapture(16000);
    mic.start = () => Promise.reject(new Error("NotAllowedError"));
    const vad = new FakeVadDetector();
    const client = new WsSttClient({
      socketFactory: () => {
        socket = new FakeWebSocket();
        created += 1;
        return socket;
      },
      mic,
      vad,
      reconnectDelayMs: () => 0,
    });

    await expect(client.start()).rejects.toThrow(/Microphone capture failed/i);
    // The half-open socket was closed as part of the teardown -- and, crucially,
    // that intentional close did NOT trigger a reconnect.
    expect(socket!.closed).toBe(true);
    await flush();
    expect(created).toBe(1); // teardown close must not reconnect
  });
});

describe("unexpected drop -> reconnect (headline)", () => {
  it("reconnects and re-sends `start` after an UNEXPECTED close, keeping mic running", async () => {
    const h = makeClient();
    h.client.start();
    h.socket.open();
    h.socket.server({ type: "ready" });
    expect(h.socketsCreated).toBe(1);

    // The upstream drops unexpectedly (server-initiated close).
    h.socket.close();
    // The drop is surfaced (not swallowed) and a reconnect is scheduled.
    expect(h.errors.at(-1)).toMatch(/reconnect/i);

    await flush();
    // A fresh socket was opened; the mic was never torn down across the drop.
    expect(h.socketsCreated).toBe(2);
    expect(h.mic.running).toBe(true);

    // The new socket re-sends the `start` control message on open and resumes.
    h.socket.open();
    expect(h.socket.sentControl).toEqual([
      { type: "start", sampleRate: 16000, latency: "low" },
    ]);
    h.socket.server({ type: "ready" });
    h.vad.emitSpeechStart();
    h.mic.emitFrame(frame(7));
    expect(h.socket.sentBinary).toHaveLength(1);
  });

  it("does NOT reconnect after an intentional stop()", async () => {
    const h = makeClient();
    h.client.start();
    h.socket.open();
    h.socket.server({ type: "ready" });

    h.client.stop(); // intentional -- closes the socket
    await flush();
    expect(h.socketsCreated).toBe(1); // no new socket
    expect(h.errors).toEqual([]); // no "reconnecting" surfaced
  });

  it("gives up after the retry cap and surfaces a persistent error", async () => {
    const h = makeClient({ maxReconnectAttempts: 2 });
    h.client.start();
    h.socket.open();
    h.socket.server({ type: "ready" }); // budget refreshed here

    // Drop repeatedly; each reconnect opens a socket that never reaches `ready`.
    h.socket.close(); // attempt 1 scheduled
    await flush();
    h.socket.close(); // attempt 2 scheduled
    await flush();
    h.socket.close(); // budget exhausted -> persistent error, no more sockets
    await flush();

    // 1 initial + 2 reconnects = 3 sockets; the 3rd drop does not open a 4th.
    expect(h.socketsCreated).toBe(3);
    expect(h.errors.at(-1)).toMatch(/could not be restored/i);
  });
});
