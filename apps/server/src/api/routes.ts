// HTTP + WS route registration. Handlers are thin shells around the pure core
// (@yammer/core) plus the injected repos and providers; nothing here mutates
// AppState directly -- the reducer does. `registerRoutes` and `RouteDeps` are the
// seam app.ts wires.

import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { LlmProvider, SearchProvider, Version } from "@yammer/shared";
import type { Repos, User } from "../db/repos";
import {
  clearSessionCookie,
  requireUser,
  sessionMiddleware,
  setSessionCookie,
} from "../auth/session";
import {
  buildAuthUrl,
  exchangeCode,
  googleConfigFromEnv,
} from "../auth/google";
import { handleTurn } from "./turn";
import { handleResearch } from "./research";
import { exportDocument } from "./export";
import { sanitizeFilename, settingsSchema, sortKeySchema } from "./validation";

/** Everything the route handlers need, injected so they stay testable. */
export interface RouteDeps {
  repos: Repos;
  llm: LlmProvider;
  search: SearchProvider;
}

const OAUTH_STATE_COOKIE = "yammer_oauth_state";

/** Public projection of a user (there are no secret fields, but be explicit). */
function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    settings: u.settings,
  };
}

/**
 * Mount every route (/api/turn, /api/research, /api/documents, /api/versions,
 * /api/settings, /api/diagnostics, the /api/stt WS placeholder, auth) onto `app`.
 */
export function registerRoutes(app: Hono, deps: RouteDeps): void {
  const { repos } = deps;

  // -- Google OAuth (no session required) --------------------------------
  app.get("/auth/google", (c) => {
    const redirectUri = new URL("/auth/google/callback", c.req.url).toString();
    const config = googleConfigFromEnv(redirectUri);
    const state = randomUUID();
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
      secure: process.env.NODE_ENV === "production",
    });
    return c.redirect(buildAuthUrl(config, state));
  });

  app.get("/auth/google/callback", async (c) => {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const savedState = getCookie(c, OAUTH_STATE_COOKIE);
    if (!code) return c.json({ error: "missing authorization code" }, 400);
    if (!state || state !== savedState) {
      return c.json({ error: "invalid oauth state" }, 400);
    }
    const redirectUri = new URL("/auth/google/callback", c.req.url).toString();
    const profile = await exchangeCode(googleConfigFromEnv(redirectUri), code);

    let user = await repos.users.findByGoogleSub(profile.googleSub);
    if (!user) user = await repos.users.create(profile);

    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
    setSessionCookie(c, user.id);
    return c.redirect("/");
  });

  app.post("/auth/logout", (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  // -- Everything under /api requires a valid session --------------------
  app.use("/api/*", sessionMiddleware(repos));

  app.get("/api/me", (c) => c.json({ user: publicUser(requireUser(c)) }));

  // -- Settings ----------------------------------------------------------
  app.get("/api/settings", async (c) => {
    const user = requireUser(c);
    return c.json({ settings: await repos.settings.get(user.id) });
  });

  app.put("/api/settings", async (c) => {
    const user = requireUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      settings?: unknown;
    } | null;
    const parsed = settingsSchema.safeParse(body?.settings ?? body);
    if (!parsed.success) {
      return c.json({ error: "invalid settings", detail: parsed.error.issues }, 400);
    }
    return c.json({ settings: await repos.settings.update(user.id, parsed.data) });
  });

  // -- Documents ---------------------------------------------------------
  app.get("/api/documents", async (c) => {
    const user = requireUser(c);
    const raw = c.req.query("sort");
    const sort = sortKeySchema.safeParse(raw).success
      ? (raw as "name" | "created" | "updated")
      : user.settings.loadDocSort;
    return c.json({ documents: await repos.documents.list(user.id, sort) });
  });

  app.post("/api/documents", async (c) => {
    const user = requireUser(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" && body.name ? body.name : undefined;
    return c.json({ document: await repos.documents.create(user.id, { name }) }, 201);
  });

  app.get("/api/documents/:id", async (c) => {
    const user = requireUser(c);
    const doc = await repos.documents.get(user.id, c.req.param("id"));
    if (!doc) return c.json({ error: "not found" }, 404);
    return c.json({ document: doc });
  });

  app.patch("/api/documents/:id", async (c) => {
    const user = requireUser(c);
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    if (typeof body?.name !== "string" || !body.name) {
      return c.json({ error: "name (non-empty string) is required" }, 400);
    }
    // Ownership: rename's WHERE is scoped to userId; confirm existence for a clean 404.
    const doc = await repos.documents.get(user.id, id);
    if (!doc) return c.json({ error: "not found" }, 404);
    return c.json({ document: await repos.documents.rename(user.id, id, body.name) });
  });

  app.get("/api/documents/:id/versions", async (c) => {
    const user = requireUser(c);
    const id = c.req.param("id");
    const doc = await repos.documents.get(user.id, id);
    if (!doc) return c.json({ error: "not found" }, 404);
    return c.json({ versions: await repos.versions.listForDocument(user.id, id) });
  });

  // The client is authoritative: it applies the reducer, then persists the
  // resulting Version here. Append-only + idempotent, so client retries are safe.
  app.post("/api/documents/:id/versions", async (c) => {
    const user = requireUser(c);
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as {
      version?: unknown;
      undoStack?: unknown;
      undoCursor?: unknown;
    } | null;

    const version = body?.version as Version | undefined;
    if (
      !version ||
      typeof version !== "object" ||
      typeof version.id !== "string" ||
      typeof version.seq !== "number" ||
      typeof version.documentId !== "string"
    ) {
      return c.json({ error: "version (with id, seq, documentId) is required" }, 400);
    }
    if (version.documentId !== id) {
      return c.json({ error: "version.documentId does not match the URL" }, 400);
    }

    // Ownership: 404 for a document that isn't the caller's (or doesn't exist).
    const doc = await repos.documents.get(user.id, id);
    if (!doc) return c.json({ error: "not found" }, 404);

    // Idempotent: a version already stored under this id is a no-op success, so a
    // client retry after a dropped response never errors or double-appends.
    const existing = await repos.versions.get(user.id, version.id);
    if (existing) return c.json({ version: existing });

    // Append-only + monotonic: the new version must be exactly head + 1. A gap or a
    // seq already used by a DIFFERENT id (seq <= head) is a conflict, not an append.
    if (version.seq !== doc.currentSeq + 1) {
      return c.json(
        {
          error: `seq conflict: expected ${doc.currentSeq + 1}, got ${version.seq}`,
          expectedSeq: doc.currentSeq + 1,
        },
        409,
      );
    }

    const undo =
      Array.isArray(body?.undoStack) && typeof body?.undoCursor === "number"
        ? { undoStack: body.undoStack as string[], undoCursor: body.undoCursor }
        : undefined;
    const saved = await repos.versions.append(user.id, version, undo);
    return c.json({ version: saved }, 201);
  });

  app.get("/api/documents/:id/export", async (c) => {
    const user = requireUser(c);
    const format = c.req.query("format");
    if (format !== "md" && format !== "docx") {
      return c.json({ error: "format must be 'md' or 'docx'" }, 400);
    }
    const doc = await repos.documents.get(user.id, c.req.param("id"));
    if (!doc) return c.json({ error: "not found" }, 404);
    const file = await exportDocument(doc.name, doc.text, format);
    c.header("Content-Type", file.contentType);
    c.header("Content-Disposition", `attachment; filename="${file.filename}"`);
    return c.body(file.body);
  });

  app.get("/api/documents/:id/diagnostics", async (c) => {
    const user = requireUser(c);
    const id = c.req.param("id");
    const doc = await repos.documents.get(user.id, id);
    if (!doc) return c.json({ error: "not found" }, 404);
    const [turns, versions] = await Promise.all([
      repos.turns.listForDocument(user.id, id),
      repos.versions.listForDocument(user.id, id),
    ]);
    c.header(
      "Content-Disposition",
      `attachment; filename="${sanitizeFilename(doc.name)}-diagnostics.json"`,
    );
    return c.json({
      generatedAt: new Date().toISOString(),
      document: doc,
      turns,
      versions,
    });
  });

  // -- LLM turn loop + research ------------------------------------------
  app.post("/api/turn", (c) => handleTurn(c, deps));
  app.post("/api/research", (c) => handleResearch(c, deps));

  // -- STT WebSocket placeholder -----------------------------------------
  // The proxy bridge (stt/bridge.ts) is unit-tested with a fake upstream; the
  // actual socket upgrade is wired in the voice phase (needs a node-ws adapter).
  app.get("/api/stt", (c) =>
    c.json(
      {
        error: "upgrade required",
        detail: "WebSocket STT endpoint; the HTTP upgrade is wired in the voice phase.",
      },
      426,
    ),
  );
}
