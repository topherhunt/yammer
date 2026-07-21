import { describe, expect, it } from "vitest";
import { FakeMicCapture, FakeVadDetector } from "../voice/fakes";
import { FakeWebSocket } from "./fake-socket";
import { WsSttClient } from "./ws-stt";

// WsSttClient speaks the shared wire protocol over an injected socket + mic + VAD.
// Everything is faked -- no real WebSocket, mic, or model.

function makeClient() {
  let socket: FakeWebSocket | null = null;
  const mic = new FakeMicCapture(16000);
  const vad = new FakeVadDetector();
  const errors: string[] = [];
  const client = new WsSttClient({
    socketFactory: () => {
      socket = new FakeWebSocket();
      return socket;
    },
    mic,
    vad,
    latency: "low",
    onError: (m) => errors.push(m),
  });
  return {
    client,
    mic,
    vad,
    errors,
    get socket(): FakeWebSocket {
      if (!socket) throw new Error("socket not created yet");
      return socket;
    },
  };
}

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
