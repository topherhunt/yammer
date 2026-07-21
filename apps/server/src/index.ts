// Node entry point: read env, construct real deps (db, providers), build the
// Hono app, and serve. Deliberately thin -- all behavior lives in the routes and
// the pure core. Fails loudly if a required env var is missing.

import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createLlmProvider, createSearchProvider } from "@yammer/providers";
import { buildApp } from "./app";
import { createRepos } from "./db/repos";
import { schema } from "./db/schema";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const port = Number(process.env.PORT ?? 3000);

const sql = postgres(requireEnv("DATABASE_URL"));
const db = drizzle(sql, { schema });

const repos = createRepos(db);
const llm = createLlmProvider({
  apiKey: requireEnv("OPENAI_API_KEY"),
  model: process.env.LLM_MODEL ?? "gpt-5.6-luna",
});
const search = createSearchProvider({ apiKey: requireEnv("TAVILY_API_KEY") });

const app = buildApp({ repos, llm, search });

serve({ fetch: app.fetch, port });
// eslint-disable-next-line no-console
console.log(`Yammer server listening on :${port}`);
