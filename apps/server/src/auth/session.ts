// HTTP-only signed session cookies + the middleware that guards every data route.
// Fails explicitly: a missing SESSION_SECRET throws (never a silent insecure
// default), and any unverifiable / expired / unknown-user cookie is a hard 401.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Repos, User } from "../db/repos";

// Make c.get("user") / c.set("user", ...) type-safe across all handlers.
declare module "hono" {
  interface ContextVariableMap {
    user: User;
  }
}

export const SESSION_COOKIE = "yammer_session";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Missing required env var: SESSION_SECRET");
  return secret;
}

/** Sign `${payloadB64}.${hmac}`; payload carries the user id and issued-at. */
export function signSession(
  userId: string,
  secret: string,
  iat: number = Date.now(),
): string {
  const payload = Buffer.from(JSON.stringify({ uid: userId, iat })).toString(
    "base64url",
  );
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Verify signature + age; returns the user id or null (never throws on bad input). */
export function verifySession(
  token: string,
  secret: string,
  maxAgeMs: number = MAX_AGE_MS,
): string | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;

  let parsed: { uid?: unknown; iat?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed.uid !== "string" || typeof parsed.iat !== "number") {
    return null;
  }
  if (Date.now() - parsed.iat > maxAgeMs) return null;
  return parsed.uid;
}

export function setSessionCookie(c: Context, userId: string): void {
  setCookie(c, SESSION_COOKIE, signSession(userId, getSessionSecret()), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(MAX_AGE_MS / 1000),
    secure: process.env.NODE_ENV === "production",
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Guards `/api/*`: verifies the cookie and loads the user onto the context. */
export function sessionMiddleware(repos: Repos): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const uid = verifySession(token, getSessionSecret());
    if (!uid) return c.json({ error: "unauthorized" }, 401);
    const user = await repos.users.findById(uid);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    await next();
    return;
  };
}

/** The authenticated user; throws if the guard middleware did not run first. */
export function requireUser(c: Context): User {
  const user = c.get("user");
  if (!user) {
    throw new Error("No authenticated user on context (session guard missing).");
  }
  return user;
}
