// HTTP -> WebSocket upgrade wiring for GET /api/stt, bolted onto the Node http
// server from @hono/node-server (Hono's fetch adapter can't own the raw upgrade).
// This is thin transport glue: authenticate the cookie, complete the ws handshake,
// then hand every frame to the pure, unit-tested bridge. All the protocol + cost
// logic lives in bridge.ts; the socket handling here is not unit-tested (it would
// need real sockets) and is covered by the live voice build.

import type { Server as HttpServer } from "node:http";
import type { ServerType } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createSttBridge,
  type OpenSttUpstream,
  type SttClientChannel,
  type SttConcurrencyRegistry,
  type SttLimits,
} from "./bridge";
import { getSessionSecret, SESSION_COOKIE, verifySession } from "../auth/session";
import type { Repos } from "../db/repos";

export interface SttUpgradeDeps {
  repos: Repos;
  openUpstream: OpenSttUpstream;
  limits: SttLimits;
  concurrency: SttConcurrencyRegistry;
}

const STT_PATH = "/api/stt";

/** Parse a single cookie value out of a raw `Cookie:` header. */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Resolve the authenticated user id for an upgrade request the same way
 * sessionMiddleware does for HTTP: valid signature AND a user that still exists.
 * Returns null (never throws) for any unauthenticated request.
 */
async function authenticateUpgrade(
  repos: Repos,
  cookieHeader: string | undefined,
): Promise<string | null> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const uid = verifySession(token, getSessionSecret());
  if (!uid) return null;
  const user = await repos.users.findById(uid);
  return user ? user.id : null;
}

/** Adapt a live ws socket to the bridge's client channel (protocol -> JSON text). */
function wsClientChannel(ws: WebSocket): SttClientChannel {
  return {
    send: (message) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    },
    close: (code) => ws.close(code),
  };
}

/**
 * Attach the STT WebSocket upgrade handler to `server`. Non-/api/stt upgrade
 * attempts are refused at the socket level; /api/stt completes the handshake and
 * then defers entirely to the bridge (which itself refuses unauthenticated or
 * over-cap sessions with a `closed` frame and no upstream).
 */
export function attachSttUpgrade(server: ServerType, deps: SttUpgradeDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  // @hono/node-server returns the plain http.Server here (we pass no http2
  // options), which is the only variant that emits the `upgrade` we handle.
  const httpServer = server as HttpServer;
  httpServer.on("upgrade", (req, socket, head) => {
    // req.url is a path (+query); the host is irrelevant for the path check.
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname !== STT_PATH) {
      socket.destroy();
      return;
    }

    void authenticateUpgrade(deps.repos, req.headers.cookie).then((userId) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const bridge = createSttBridge({
          client: wsClientChannel(ws),
          userId,
          openUpstream: deps.openUpstream,
          limits: deps.limits,
          concurrency: deps.concurrency,
        });
        ws.on("message", (data, isBinary) =>
          bridge.onClientMessage(data, isBinary),
        );
        ws.on("close", () => bridge.onClientClose());
        ws.on("error", () => bridge.onClientClose());
      });
    });
  });
}
