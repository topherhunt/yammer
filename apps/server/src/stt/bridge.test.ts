import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { SttServerMessage } from "@yammer/shared";
import {
  createConcurrencyRegistry,
  createSttBridge,
  parseUpstreamEvent,
  sttLimitsFromEnv,
  type OpenSttUpstream,
  type SttConcurrencyRegistry,
  type SttLimits,
  type SttUpstream,
} from "./bridge";

/** A fake OpenAI upstream: records audio sends, lets the test drive open/message/
 *  close/error. Never opens a real socket. */
function fakeUpstream() {
  let openCb: (() => void) | undefined;
  let messageCb: ((d: unknown) => void) | undefined;
  let closeCb: (() => void) | undefined;
  let errorCb: ((e: unknown) => void) | undefined;
  const sent: Uint8Array[] = [];
  let commits = 0;
  let closed = false;
  const upstream: SttUpstream = {
    send: (d) => sent.push(d),
    commit: () => {
      commits += 1;
    },
    close: () => {
      closed = true;
    },
    onOpen: (cb) => {
      openCb = cb;
    },
    onMessage: (cb) => {
      messageCb = cb;
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    onError: (cb) => {
      errorCb = cb;
    },
  };
  return {
    upstream,
    sent,
    commits: () => commits,
    isClosed: () => closed,
    emitOpen: () => openCb?.(),
    emitMessage: (d: unknown) => messageCb?.(d),
    emitClose: () => closeCb?.(),
    emitError: (e: unknown) => errorCb?.(e),
  };
}

function fakeClient() {
  const received: SttServerMessage[] = [];
  let closed = false;
  return {
    channel: {
      send: (message: SttServerMessage) => received.push(message),
      close: () => {
        closed = true;
      },
    },
    received,
    isClosed: () => closed,
    last: () => received[received.length - 1],
  };
}

/** Roomy limits so a test only trips the cap it is exercising. */
function testLimits(overrides: Partial<SttLimits> = {}): SttLimits {
  return {
    maxSessionMs: 60_000,
    idleMs: 10_000,
    maxTotalBytes: 10_000_000,
    maxFrameBytes: 1_000_000,
    maxPerUser: 3,
    ...overrides,
  };
}

/** The JSON `start` control frame the client sends first (text, not binary). */
function startFrame(sampleRate = 24_000): string {
  return JSON.stringify({ type: "start", sampleRate });
}

/** A binary audio frame of `n` bytes. */
function audio(n: number): Uint8Array {
  return new Uint8Array(n);
}

interface HarnessOpts {
  userId?: string | null;
  limits?: Partial<SttLimits>;
  concurrency?: SttConcurrencyRegistry;
}

/** Wire a bridge to fresh fakes; track whether the upstream factory was called. */
function harness(opts: HarnessOpts = {}) {
  const up = fakeUpstream();
  const client = fakeClient();
  let openCalls = 0;
  let lastParams: { sampleRate: number } | undefined;
  const openUpstream: OpenSttUpstream = (params) => {
    openCalls += 1;
    lastParams = params;
    return up.upstream;
  };
  const bridge = createSttBridge({
    client: client.channel,
    userId: opts.userId === undefined ? "user-1" : opts.userId,
    openUpstream,
    limits: testLimits(opts.limits),
    concurrency: opts.concurrency ?? createConcurrencyRegistry(testLimits(opts.limits).maxPerUser),
  });
  return {
    bridge,
    up,
    client,
    openedUpstream: () => openCalls > 0,
    openParams: () => lastParams,
  };
}

describe("createSttBridge -- auth gate", () => {
  it("refuses an unauthenticated upgrade with closed:unauthenticated and opens NO upstream", () => {
    const h = harness({ userId: null });
    expect(h.client.received).toEqual([{ type: "closed", reason: "unauthenticated" }]);
    expect(h.client.isClosed()).toBe(true);
    expect(h.openedUpstream()).toBe(false);

    // Post-refusal traffic is inert -- still never opens an upstream.
    h.bridge.onClientMessage(startFrame(), false);
    h.bridge.onClientMessage(audio(100), true);
    expect(h.openedUpstream()).toBe(false);
    expect(h.up.sent).toEqual([]);
  });
});

describe("createSttBridge -- start / ready / transcripts", () => {
  it("opens the upstream on `start` and passes through the sample rate", () => {
    const h = harness();
    expect(h.openedUpstream()).toBe(false); // not until the client says start
    h.bridge.onClientMessage(startFrame(16_000), false);
    expect(h.openedUpstream()).toBe(true);
    expect(h.openParams()).toEqual({ sampleRate: 16_000, latency: undefined });
  });

  it("emits `ready` only after the upstream opens, never before", () => {
    const h = harness();
    h.bridge.onClientMessage(startFrame(), false);
    expect(h.client.received).toEqual([]); // upstream not open yet -> no ready
    h.up.emitOpen();
    expect(h.client.received).toEqual([{ type: "ready" }]);
  });

  it("maps upstream deltas to interim and completed to final with metered seconds", () => {
    const h = harness();
    h.bridge.onClientMessage(startFrame(24_000), false);
    h.up.emitOpen();
    // 48000 bytes of PCM16 @ 24kHz mono = 1.0 second of audio.
    h.bridge.onClientMessage(audio(48_000), true);

    // Deltas arrive as incremental fragments; the bridge accumulates them so the
    // client sees the full running sentence, not just the latest token.
    const delta = (t: string) =>
      h.up.emitMessage(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          delta: t,
        }),
      );
    delta("hel");
    delta("lo");
    delta(" there");
    h.up.emitMessage(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hello there",
      }),
    );

    expect(h.client.received).toEqual([
      { type: "ready" },
      { type: "interim", text: "hel" },
      { type: "interim", text: "hello" },
      { type: "interim", text: "hello there" },
      { type: "final", text: "hello there", seconds: 1 },
    ]);
  });

  it("resets the accumulated interim after a final, so the next utterance starts fresh", () => {
    const h = harness();
    h.bridge.onClientMessage(startFrame(24_000), false);
    h.up.emitOpen();
    const delta = (t: string) =>
      h.up.emitMessage(
        JSON.stringify({ type: "x.transcription.delta", delta: t }),
      );
    const done = (t: string) =>
      h.up.emitMessage(
        JSON.stringify({ type: "x.transcription.completed", transcript: t }),
      );

    delta("one");
    done("one");
    delta("two"); // must NOT be "onetwo"
    done("two");

    const interims = h.client.received.filter((m) => m.type === "interim");
    expect(interims).toEqual([
      { type: "interim", text: "one" },
      { type: "interim", text: "two" },
    ]);
  });
});

describe("createSttBridge -- buffer until open", () => {
  it("buffers audio received before the upstream is OPEN, then flushes it on open", () => {
    const h = harness();
    h.bridge.onClientMessage(startFrame(), false);
    // Audio arrives while the upstream socket is still connecting -- must NOT throw
    // or tear down, and must NOT reach the upstream yet.
    h.bridge.onClientMessage(audio(10), true);
    h.bridge.onClientMessage(audio(20), true);
    expect(h.up.sent).toEqual([]);
    expect(h.client.isClosed()).toBe(false);

    h.up.emitOpen();
    // Flushed in order on open, and only THEN is ready sent.
    expect(h.up.sent.map((f) => f.byteLength)).toEqual([10, 20]);
    expect(h.client.received).toEqual([{ type: "ready" }]);

    // Post-open audio goes straight through.
    h.bridge.onClientMessage(audio(30), true);
    expect(h.up.sent.map((f) => f.byteLength)).toEqual([10, 20, 30]);
  });
});

describe("createSttBridge -- commit (end-of-speech)", () => {
  it("forwards a `commit` control message to the upstream once open", () => {
    const h = harness();
    h.bridge.onClientMessage(startFrame(24_000), false);
    h.up.emitOpen();
    h.bridge.onClientMessage(audio(48_000), true);

    h.bridge.onClientMessage(JSON.stringify({ type: "commit" }), false);
    expect(h.up.commits()).toBe(1);
    // A commit is not a session teardown -- the session stays open for more audio.
    expect(h.client.isClosed()).toBe(false);
  });

  it("defers a commit that arrives before the upstream is open, firing it after the buffered audio flushes", () => {
    const h = harness();
    h.bridge.onClientMessage(startFrame(24_000), false);
    // Audio + commit both arrive while the upstream is still connecting.
    h.bridge.onClientMessage(audio(24_000), true);
    h.bridge.onClientMessage(JSON.stringify({ type: "commit" }), false);
    expect(h.up.commits()).toBe(0); // nothing sent upstream yet

    h.up.emitOpen();
    // The buffered audio is flushed first, THEN the deferred commit fires.
    expect(h.up.sent.map((f) => f.byteLength)).toEqual([24_000]);
    expect(h.up.commits()).toBe(1);
  });

  it("ignores a commit before `start` (no upstream to commit)", () => {
    const h = harness();
    h.bridge.onClientMessage(JSON.stringify({ type: "commit" }), false);
    expect(h.openedUpstream()).toBe(false);
    expect(h.client.isClosed()).toBe(false);
  });
});

describe("createSttBridge -- lifecycle + cost caps", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("closes both with max_duration when the session outlives the cap", () => {
    const h = harness({ limits: { maxSessionMs: 5_000 } });
    h.bridge.onClientMessage(startFrame(), false);
    h.up.emitOpen();

    vi.advanceTimersByTime(5_000);
    expect(h.client.last()).toEqual({ type: "closed", reason: "max_duration" });
    expect(h.client.isClosed()).toBe(true);
    expect(h.up.isClosed()).toBe(true);
  });

  it("closes both with idle_timeout after N seconds without audio, and audio resets the clock", () => {
    const h = harness({ limits: { idleMs: 5_000 } });
    h.bridge.onClientMessage(startFrame(), false);
    h.up.emitOpen();

    vi.advanceTimersByTime(4_000);
    h.bridge.onClientMessage(audio(10), true); // resets the idle clock
    vi.advanceTimersByTime(4_000);
    expect(h.client.isClosed()).toBe(false); // 8s elapsed but never 5s idle

    vi.advanceTimersByTime(5_000);
    expect(h.client.last()).toEqual({ type: "closed", reason: "idle_timeout" });
    expect(h.up.isClosed()).toBe(true);
  });

  it("closes both with byte_budget when cumulative audio exceeds the budget", () => {
    const h = harness({ limits: { maxTotalBytes: 100 } });
    h.bridge.onClientMessage(startFrame(), false);
    h.up.emitOpen();

    h.bridge.onClientMessage(audio(60), true);
    expect(h.client.isClosed()).toBe(false);
    h.bridge.onClientMessage(audio(60), true); // 120 > 100 -> over budget
    expect(h.client.last()).toEqual({ type: "closed", reason: "byte_budget" });
    expect(h.up.isClosed()).toBe(true);
  });

  it("closes both with byte_budget when a single frame exceeds the per-frame cap", () => {
    const h = harness({ limits: { maxFrameBytes: 100, maxTotalBytes: 10_000 } });
    h.bridge.onClientMessage(startFrame(), false);
    h.up.emitOpen();

    h.bridge.onClientMessage(audio(101), true); // one oversized frame
    expect(h.client.last()).toEqual({ type: "closed", reason: "byte_budget" });
    expect(h.up.isClosed()).toBe(true);
    expect(h.up.sent).toEqual([]); // never forwarded upstream
  });
});

describe("createSttBridge -- per-user concurrency cap", () => {
  it("refuses a user's (N+1)th socket without opening an upstream, releasing on close", () => {
    const registry = createConcurrencyRegistry(2);
    const a = harness({ userId: "u", concurrency: registry });
    const b = harness({ userId: "u", concurrency: registry });
    // Third concurrent socket for the same user is over the cap.
    const c = harness({ userId: "u", concurrency: registry });

    expect(a.openedUpstream()).toBe(false); // no start yet, but not refused either
    expect(c.client.received).toEqual([{ type: "closed", reason: "server_error" }]);
    expect(c.client.isClosed()).toBe(true);

    // A different user is unaffected by u's saturation.
    const other = harness({ userId: "v", concurrency: registry });
    other.bridge.onClientMessage(startFrame(), false);
    expect(other.openedUpstream()).toBe(true);

    // Freeing one of u's slots lets a new u socket in again.
    a.bridge.onClientClose();
    const d = harness({ userId: "u", concurrency: registry });
    d.bridge.onClientMessage(startFrame(), false);
    expect(d.openedUpstream()).toBe(true);
  });
});

describe("createSttBridge -- teardown + protocol", () => {
  it("closes both with `done` on a client `stop` control message", () => {
    const h = harness();
    h.bridge.onClientMessage(startFrame(), false);
    h.up.emitOpen();
    h.bridge.onClientMessage(JSON.stringify({ type: "stop" }), false);
    expect(h.client.last()).toEqual({ type: "closed", reason: "done" });
    expect(h.up.isClosed()).toBe(true);
  });

  it("closes both with `done` when the client disconnects, and drops later traffic", () => {
    const h = harness();
    h.bridge.onClientMessage(startFrame(), false);
    h.up.emitOpen();
    h.bridge.onClientClose();
    expect(h.client.last()).toEqual({ type: "closed", reason: "done" });
    expect(h.up.isClosed()).toBe(true);

    h.bridge.onClientMessage(audio(50), true);
    h.up.emitMessage(JSON.stringify({ type: "x.transcription.delta", delta: "late" }));
    expect(h.up.sent).toEqual([]);
  });

  it("surfaces an upstream error then closes both with server_error", () => {
    const h = harness();
    h.bridge.onClientMessage(startFrame(), false);
    h.up.emitOpen();
    h.up.emitError(new Error("socket reset"));
    expect(h.client.received).toEqual([
      { type: "ready" },
      { type: "error", message: "socket reset" },
      { type: "closed", reason: "server_error" },
    ]);
    expect(h.up.isClosed()).toBe(true);
  });

  it("closes with server_error on a spontaneous upstream close", () => {
    const h = harness();
    h.bridge.onClientMessage(startFrame(), false);
    h.up.emitOpen();
    h.up.emitClose();
    expect(h.client.last()).toEqual({ type: "closed", reason: "server_error" });
    expect(h.client.isClosed()).toBe(true);
  });

  it("rejects a malformed control frame with an error then closes", () => {
    const h = harness();
    h.bridge.onClientMessage("not json {", false);
    expect(h.client.received).toEqual([
      { type: "error", message: "malformed control message" },
      { type: "closed", reason: "server_error" },
    ]);
    expect(h.openedUpstream()).toBe(false);
  });
});

describe("createSttBridge -- start control validation (spend-meter safety)", () => {
  it("rejects a start whose sampleRate is non-numeric: error + close, NO upstream opened", () => {
    const h = harness();
    // {"sampleRate":"fast"} would set sampleRate = NaN and meter NaN audio-seconds,
    // corrupting the per-document spend meter -- so it must be refused up front.
    h.bridge.onClientMessage(JSON.stringify({ type: "start", sampleRate: "fast" }), false);
    expect(h.client.received).toEqual([
      { type: "error", message: "invalid control message" },
      { type: "closed", reason: "server_error" },
    ]);
    expect(h.openedUpstream()).toBe(false);
    expect(h.client.isClosed()).toBe(true);
  });

  it("rejects a start with an absent sampleRate the same way, opening no upstream", () => {
    const h = harness();
    h.bridge.onClientMessage(JSON.stringify({ type: "start" }), false);
    expect(h.client.received).toEqual([
      { type: "error", message: "invalid control message" },
      { type: "closed", reason: "server_error" },
    ]);
    expect(h.openedUpstream()).toBe(false);
  });

  it("rejects a start with a non-positive sampleRate (0), opening no upstream", () => {
    const h = harness();
    h.bridge.onClientMessage(JSON.stringify({ type: "start", sampleRate: 0 }), false);
    expect(h.client.received).toEqual([
      { type: "error", message: "invalid control message" },
      { type: "closed", reason: "server_error" },
    ]);
    expect(h.openedUpstream()).toBe(false);
  });

  it("accepts a well-formed start (valid numeric sampleRate) and opens the upstream", () => {
    const h = harness();
    h.bridge.onClientMessage(JSON.stringify({ type: "start", sampleRate: 24_000 }), false);
    expect(h.openedUpstream()).toBe(true);
    expect(h.openParams()).toEqual({ sampleRate: 24_000, latency: undefined });
  });
});

describe("parseUpstreamEvent", () => {
  it("maps delta events to interim, completed to final, errors to error, else ignore", () => {
    expect(
      parseUpstreamEvent('{"type":"conversation.item.input_audio_transcription.delta","delta":"hi"}'),
    ).toEqual({ kind: "interim", text: "hi" });
    expect(
      parseUpstreamEvent('{"type":"conversation.item.input_audio_transcription.completed","transcript":"hello"}'),
    ).toEqual({ kind: "final", text: "hello" });
    expect(parseUpstreamEvent('{"type":"error","error":{"message":"boom"}}')).toEqual({
      kind: "error",
      message: "boom",
    });
    expect(parseUpstreamEvent('{"type":"session.created"}')).toEqual({ kind: "ignore" });
    expect(parseUpstreamEvent("garbage")).toEqual({ kind: "ignore" });
  });
});

describe("sttLimitsFromEnv", () => {
  it("applies documented defaults when nothing is set", () => {
    expect(sttLimitsFromEnv({})).toEqual({
      maxSessionMs: 600_000,
      idleMs: 30_000,
      maxTotalBytes: 33_554_432,
      maxFrameBytes: 1_048_576,
      maxPerUser: 3,
    });
  });

  it("reads overrides from env", () => {
    const limits = sttLimitsFromEnv({ STT_IDLE_TIMEOUT_MS: "5000", STT_MAX_SOCKETS_PER_USER: "1" });
    expect(limits.idleMs).toBe(5_000);
    expect(limits.maxPerUser).toBe(1);
  });

  it("fails loudly on a present-but-invalid value", () => {
    expect(() => sttLimitsFromEnv({ STT_MAX_SESSION_MS: "-1" })).toThrow(/STT_MAX_SESSION_MS/);
    expect(() => sttLimitsFromEnv({ STT_IDLE_TIMEOUT_MS: "abc" })).toThrow(/STT_IDLE_TIMEOUT_MS/);
  });
});
