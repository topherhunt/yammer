import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ServerType } from "@hono/node-server";
import { attachSttUpgrade } from "./upgrade";
import {
  createConcurrencyRegistry,
  sttLimitsFromEnv,
  type OpenSttUpstream,
} from "./bridge";
import { signSession, SESSION_COOKIE } from "../auth/session";
import type { Repos } from "../db/repos";

// The raw HTTP upgrade path is transport glue, but the authenticateUpgrade promise
// CAN reject (a transient DB outage in users.findById, or a missing SESSION_SECRET
// in getSessionSecret). If that rejection is not caught, it is unhandled (fatal
// under a strict unhandledRejection handler) AND the raw socket is left open,
// leaking a file descriptor. These tests pin the .catch that destroys the socket.

const SECRET = "upgrade-test-secret";

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.SESSION_SECRET;
});

/** A fake http server that just lets us emit `upgrade` synchronously. */
function fakeServer(): { server: ServerType; emitUpgrade: (req: unknown, socket: unknown) => void } {
  const emitter = new EventEmitter();
  return {
    server: emitter as unknown as ServerType,
    emitUpgrade: (req, socket) => emitter.emit("upgrade", req, socket, Buffer.alloc(0)),
  };
}

/** Flush pending microtasks so the authenticate promise settles. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** An openUpstream that fails the test if the rejection path ever reaches it. */
const openUpstreamNever: OpenSttUpstream = () => {
  throw new Error("openUpstream must not be called on an auth rejection");
};

function deps(repos: Repos): Parameters<typeof attachSttUpgrade>[1] {
  const limits = sttLimitsFromEnv({});
  return {
    repos,
    openUpstream: openUpstreamNever,
    limits,
    concurrency: createConcurrencyRegistry(limits.maxPerUser),
  };
}

describe("attachSttUpgrade -- authentication rejection", () => {
  it("destroys the raw socket (no FD leak) and never rethrows when the DB lookup throws", async () => {
    // A validly-signed cookie so authentication gets PAST verifySession to the DB
    // lookup -- which then throws, simulating a transient Postgres outage.
    const uid = "user-42";
    const findById = vi.fn(async () => {
      throw new Error("db connection reset");
    });
    const repos = { users: { findById } } as unknown as Repos;

    const { server, emitUpgrade } = fakeServer();
    attachSttUpgrade(server, deps(repos));

    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const destroy = vi.fn();
    const req = {
      url: "/api/stt",
      headers: { cookie: `${SESSION_COOKIE}=${signSession(uid, SECRET)}` },
    };

    // Emitting must not throw synchronously, and the rejection must be swallowed.
    expect(() => emitUpgrade(req, { destroy })).not.toThrow();
    await flush();

    expect(findById).toHaveBeenCalledWith(uid);
    expect(destroy).toHaveBeenCalledTimes(1);
    // The failure is logged, not silently dropped.
    expect(errorLog).toHaveBeenCalledWith(
      "STT upgrade authentication failed:",
      expect.any(Error),
    );
    errorLog.mockRestore();
  });

  it("destroys the socket at once for a non-/api/stt upgrade without touching the DB", () => {
    const findById = vi.fn(async () => null);
    const repos = { users: { findById } } as unknown as Repos;
    const { server, emitUpgrade } = fakeServer();
    attachSttUpgrade(server, deps(repos));

    const destroy = vi.fn();
    emitUpgrade({ url: "/somewhere/else", headers: {} }, { destroy });

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(findById).not.toHaveBeenCalled();
  });
});
