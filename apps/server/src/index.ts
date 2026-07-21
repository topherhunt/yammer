// Node entry point: one process serves BOTH the web client and the API on a
// single port.
//   /api/* and /auth/*  -> the Hono app (+ the /api/stt WebSocket upgrade)
//   everything else      -> the web client: Vite in middleware mode (dev, with
//                           HMR) or the built static bundle (prod).
// Same origin => no proxy, no VITE_API_BASE, and the Google OAuth redirect_uri
// is simply this server's origin. Fails loudly if a required env var is missing.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createLlmProvider, createSearchProvider } from "@yammer/providers";
import { buildApp } from "./app";
import { createRepos } from "./db/repos";
import { schema } from "./db/schema";
import {
  createConcurrencyRegistry,
  sttLimitsFromEnv,
  type OpenSttUpstream,
} from "./stt/bridge";
import { openOpenAiUpstream } from "./stt/upstream";
import { attachSttUpgrade } from "./stt/upgrade";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 3141);
// apps/server/src/index.ts -> apps/web
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

const sql = postgres(requireEnv("DATABASE_URL"));
const db = drizzle(sql, { schema });
const repos = createRepos(db);
const openaiApiKey = requireEnv("OPENAI_API_KEY");
const llm = createLlmProvider({
  apiKey: openaiApiKey,
  model: process.env.LLM_MODEL ?? "gpt-5.6-luna",
});
const search = createSearchProvider({ apiKey: requireEnv("TAVILY_API_KEY") });

const app = buildApp({ repos, llm, search });

// STT WebSocket proxy: the key stays here; the browser only ever talks to us.
const sttLimits = sttLimitsFromEnv();
const sttConcurrency = createConcurrencyRegistry(sttLimits.maxPerUser);
const openSttUpstream: OpenSttUpstream = (params) =>
  openOpenAiUpstream({
    apiKey: openaiApiKey,
    model: process.env.STT_MODEL ?? "gpt-realtime-whisper",
    sampleRate: params.sampleRate,
    latency: params.latency,
  });

const honoListener = getRequestListener(app.fetch);
const isApiPath = (url: string): boolean =>
  url.startsWith("/api") || url.startsWith("/auth");

let requestHandler: http.RequestListener;

if (isProd) {
  // Prod: the Hono app also serves the built bundle + SPA fallback. API/auth
  // routes are registered first, so they always win; everything else is static.
  const { serveStatic } = await import("@hono/node-server/serve-static");
  const { readFile } = await import("node:fs/promises");
  const distDir = path.join(webRoot, "dist");
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), distDir) }));
  app.notFound(async (c) =>
    c.html(await readFile(path.join(distDir, "index.html"), "utf8")),
  );
  requestHandler = honoListener;
} else {
  // Dev: Vite in middleware mode serves the client (with HMR). HMR runs on its
  // own ws port so it never collides with our /api/stt upgrade.
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: webRoot,
    appType: "spa",
    server: { middlewareMode: true, hmr: { port: 24679 } },
  });
  requestHandler = (req, res) => {
    if (isApiPath(req.url ?? "/")) return honoListener(req, res);
    vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  };
}

const server = http.createServer(requestHandler);
attachSttUpgrade(server, {
  repos,
  openUpstream: openSttUpstream,
  limits: sttLimits,
  concurrency: sttConcurrency,
});
server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `Yammer listening on http://localhost:${port}/  (${isProd ? "production" : "dev"})`,
  );
});
