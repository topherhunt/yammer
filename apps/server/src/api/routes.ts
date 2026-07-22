// HTTP + WS route registration. Handlers are thin shells around the pure core
// (@yammer/core) plus the injected repos and providers; nothing here mutates
// AppState directly -- the reducer does. `registerRoutes` and `RouteDeps` are the
// seam app.ts wires.

import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { LlmProvider, SearchProvider } from "@yammer/shared";
import { versionSchema } from "@yammer/shared";
import {
  DuplicateNameError,
  isUniqueViolation,
  type Repos,
  type User,
} from "../db/repos";
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
import { debugLog } from "../debug";

/** Everything the route handlers need, injected so they stay testable. */
export interface RouteDeps {
  repos: Repos;
  llm: LlmProvider;
  search: SearchProvider;
}

const OAUTH_STATE_COOKIE = "yammer_oauth_state";

// Generous but bounded: documents/context payloads can be large, but a request
// body should never exceed a few MB. Caps memory + closes an oversized-body vector.
const MAX_API_BODY_BYTES = 5 * 1024 * 1024;

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

  // -- Body-size cap on every /api route (before auth so oversized bodies are
  //    rejected early with a clean 413, not read into memory) -----------------
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_API_BODY_BYTES,
      onError: (c) => c.json({ error: "request body too large" }, 413),
    }),
  );

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
    try {
      // Create the document + its seq-0 version, then return BOTH document and
      // history so the client can adopt the authoritative base directly (no extra
      // round-trip, and no client-minted version 0 racing a not-yet-created doc).
      const document = await repos.documents.create(user.id, { name });
      const history = await repos.versions.listForDocument(user.id, document.id);
      return c.json({ document, history }, 201);
    } catch (err) {
      // Case-insensitive name collision -> 409 (never silently create a duplicate).
      if (err instanceof DuplicateNameError || isUniqueViolation(err)) {
        return c.json({ error: "a document with that name already exists" }, 409);
      }
      throw err;
    }
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
    try {
      return c.json({ document: await repos.documents.rename(user.id, id, body.name) });
    } catch (err) {
      // Renaming onto another document's name (case-insensitively) -> 409.
      if (err instanceof DuplicateNameError || isUniqueViolation(err)) {
        return c.json({ error: "a document with that name already exists" }, 409);
      }
      throw err;
    }
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
      documentName?: unknown;
    } | null;

    // Validate the FULL version envelope, not just id/seq/documentId. Casting the
    // rest as Version let a malformed body persist an inconsistent snapshot or 500
    // on a NULL column; versionSchema rejects it as a clean 400 instead.
    const parsedVersion = versionSchema.safeParse(body?.version);
    if (!parsedVersion.success) {
      return c.json(
        { error: "invalid version", detail: parsedVersion.error.issues },
        400,
      );
    }
    const version = parsedVersion.data;
    if (version.documentId !== id) {
      return c.json({ error: "version.documentId does not match the URL" }, 400);
    }

    // Ownership / existence. A missing document is normally a 404 -- EXCEPT when
    // this is the client's seq-0 "create" version: that IS the creation, so create
    // the document row from it (client-authoritative creation) and return. Any other
    // version for a missing doc is a genuine 404.
    const doc = await repos.documents.get(user.id, id);
    if (!doc) {
      if (version.seq === 0 && version.kind === "create") {
        // Idempotency: a retry after the doc already exists falls through to the
        // normal path on the next request; here the doc genuinely does not exist.
        const name =
          typeof body?.documentName === "string" ? body.documentName : undefined;
        try {
          const created = await repos.documents.createFromClientVersion(user.id, {
            id,
            name,
            version,
          });
          return c.json({ document: created, version }, 201);
        } catch (err) {
          if (isUniqueViolation(err)) {
            // The doc was created concurrently (double-submit of the create). Treat
            // as success -- the version is already stored.
            return c.json({ version }, 200);
          }
          throw err;
        }
      }
      return c.json({ error: "not found" }, 404);
    }

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
    try {
      const saved = await repos.versions.append(user.id, version, undo);
      return c.json({ version: saved }, 201);
    } catch (err) {
      // A truly concurrent append that passed the seq === head+1 check above but
      // lost the UNIQUE(document_id, seq) race raises 23505. Map it to the SAME
      // structured 409 the stale-seq path returns, not an opaque 500. Re-read the
      // head so expectedSeq reflects the winning append.
      if (isUniqueViolation(err)) {
        const fresh = await repos.documents.get(user.id, id);
        const expectedSeq = (fresh?.currentSeq ?? doc.currentSeq) + 1;
        return c.json(
          { error: `seq conflict: expected ${expectedSeq}, got ${version.seq}`, expectedSeq },
          409,
        );
      }
      throw err;
    }
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

  // -- Client debug bridge -----------------------------------------------
  // Client-side debug events (e.g. the wake-word spotter under VITE_VOSK_DEBUG) POST
  // here so they land in the same file-based debug log the agent reads -- no console
  // copy-paste. Authenticated, and only emitted when a client debug flag is on.
  app.post("/api/debug", async (c) => {
    const user = requireUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      category?: unknown;
      data?: unknown;
    } | null;
    const category = typeof body?.category === "string" ? body.category : "client";
    debugLog(`client:${category}`, { userId: user.id, data: body?.data });
    return c.json({ ok: true });
  });

  // -- STT WebSocket endpoint --------------------------------------------
  // The real WS upgrade is handled off the raw Node http server (stt/upgrade.ts),
  // which fires before Hono for `Upgrade: websocket` requests. This route is only
  // reached by a plain (non-upgrading) HTTP GET, which must use a WebSocket.
  app.get("/api/stt", (c) =>
    c.json(
      {
        error: "upgrade required",
        detail: "Connect to /api/stt over WebSocket, not plain HTTP.",
      },
      426,
    ),
  );
}
