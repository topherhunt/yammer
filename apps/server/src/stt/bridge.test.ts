import { describe, it, expect } from "vitest";
import { createSttBridge, type SttUpstream } from "./bridge";

/** A fake OpenAI upstream: records sends, lets the test drive message/close/error. */
function fakeUpstream() {
  let messageCb: ((d: unknown) => void) | undefined;
  let closeCb: (() => void) | undefined;
  let errorCb: ((e: unknown) => void) | undefined;
  const sent: unknown[] = [];
  let closed = false;
  const upstream: SttUpstream = {
    send: (d) => sent.push(d),
    close: () => {
      closed = true;
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
    isClosed: () => closed,
    emitMessage: (d: unknown) => messageCb?.(d),
    emitClose: () => closeCb?.(),
    emitError: (e: unknown) => errorCb?.(e),
  };
}

function fakeClient() {
  const received: unknown[] = [];
  let closed = false;
  return {
    channel: {
      send: (d: unknown) => received.push(d),
      close: () => {
        closed = true;
      },
    },
    received,
    isClosed: () => closed,
  };
}

describe("createSttBridge", () => {
  it("relays client audio to the upstream and upstream transcripts to the client", () => {
    const up = fakeUpstream();
    const client = fakeClient();
    const bridge = createSttBridge(client.channel, () => up.upstream);

    bridge.onClientMessage("audio-chunk-1");
    bridge.onClientMessage("audio-chunk-2");
    expect(up.sent).toEqual(["audio-chunk-1", "audio-chunk-2"]);

    up.emitMessage('{"transcript":"hello"}');
    expect(client.received).toEqual(['{"transcript":"hello"}']);
  });

  it("tears down both sides once when the upstream closes", () => {
    const up = fakeUpstream();
    const client = fakeClient();
    createSttBridge(client.channel, () => up.upstream);

    up.emitClose();
    expect(client.isClosed()).toBe(true);
    expect(up.isClosed()).toBe(true);
  });

  it("closes the upstream when the client disconnects and stops relaying", () => {
    const up = fakeUpstream();
    const client = fakeClient();
    const bridge = createSttBridge(client.channel, () => up.upstream);

    bridge.onClientClose();
    expect(up.isClosed()).toBe(true);

    // Post-close traffic is dropped, not forwarded.
    bridge.onClientMessage("late-audio");
    up.emitMessage("late-transcript");
    expect(up.sent).toEqual([]);
    expect(client.received).toEqual([]);
  });

  it("tears down on an upstream error", () => {
    const up = fakeUpstream();
    const client = fakeClient();
    createSttBridge(client.channel, () => up.upstream);

    up.emitError(new Error("socket reset"));
    expect(client.isClosed()).toBe(true);
    expect(up.isClosed()).toBe(true);
  });
});
