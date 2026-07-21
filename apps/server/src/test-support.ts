// Shared test scaffolding: an in-memory Postgres (pg-mem) wired to drizzle via the
// pg-proxy driver, plus interface-compatible fake providers and a session-cookie
// helper. No Docker, no real DB, no network, no spend.
//
// Why pg-proxy rather than pg-mem's node-pg / postgres-js adapters: this pg-mem
// build rejects `rowMode: 'array'` (which both of those drizzle drivers require)
// and cannot load the `pg-server`/`postgres.default` interop those adapters need.
// pg-proxy lets us drive the raw pg-mem query engine directly: we substitute the
// $-params ourselves and reshape pg-mem's object rows into the positional arrays
// drizzle expects (using the field order pg-mem reports for each SELECT).

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { newDb } from "pg-mem";
import { drizzle } from "drizzle-orm/pg-proxy";
import type {
  LlmProvider,
  LlmRequest,
  LlmResult,
  SearchProvider,
  SearchResult,
} from "@yammer/shared";
import { zeroUsage } from "@yammer/shared";
import { schema } from "./db/schema";
import { createRepos, type Database, type Repos } from "./db/repos";
import { signSession, SESSION_COOKIE } from "./auth/session";

const INIT_SQL = readFileSync(
  new URL("../drizzle/0000_init.sql", import.meta.url),
  "utf8",
);

/** Render a drizzle-supplied parameter as a SQL literal for pg-mem. drizzle only
 * ever passes primitives (jsonb is pre-serialized to a JSON string), so quoting
 * strings (doubling single quotes) and passing numbers/booleans/null raw is safe. */
function toLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return `'${s.replace(/'/g, "''")}'`;
}

export interface TestContext {
  db: Database;
  repos: Repos;
}

export function createTestDb(): TestContext {
  const mem = newDb();
  mem.public.none(INIT_SQL);

  const db: Database = drizzle(
    async (sqlText, params) => {
      const substituted = sqlText.replace(/\$(\d+)/g, (_m, d: string) =>
        toLiteral(params[Number(d) - 1]),
      );
      const res = mem.public.query(substituted) as {
        rows: Record<string, unknown>[];
        fields?: { name: string }[];
      };
      const fields = (res.fields ?? []).map((f) => f.name);
      const rows = res.rows.map((row) => fields.map((f) => row[f]));
      return { rows };
    },
    { schema },
  );

  return { db, repos: createRepos(db) };
}

/** Insert a user directly and return it. Each call gets a distinct googleSub. */
export async function seedUser(
  repos: Repos,
  overrides: { email?: string; name?: string; googleSub?: string } = {},
) {
  return repos.users.create({
    googleSub: overrides.googleSub ?? `sub-${randomUUID()}`,
    email: overrides.email ?? `${randomUUID()}@example.com`,
    name: overrides.name ?? "Test User",
  });
}

/** A `cookie` header carrying a valid signed session for `userId`. */
export function authHeaders(userId: string): Record<string, string> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Set SESSION_SECRET before building auth headers.");
  return { cookie: `${SESSION_COOKIE}=${signSession(userId, secret)}` };
}

/** LlmProvider fake: replays canned results in order (fails loudly when drained). */
export class FakeLlm implements LlmProvider {
  private queue: LlmResult[];
  public readonly requests: LlmRequest[] = [];

  constructor(results: LlmResult[] = []) {
    this.queue = [...results];
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.requests.push(req);
    const next = this.queue.shift();
    if (!next) throw new Error("FakeLlm has no more canned results.");
    return next;
  }
}

/** Build an LlmResult envelope with sensible usage defaults. */
export function llmResult(
  actions: unknown[],
  opts: { chatMessage?: string; usage?: Partial<LlmResult["usage"]>; raw?: unknown } = {},
): LlmResult {
  return {
    ...(opts.chatMessage !== undefined ? { chatMessage: opts.chatMessage } : {}),
    actions,
    usage: { ...zeroUsage, ...opts.usage },
    raw: opts.raw ?? { canned: true },
  };
}

/** SearchProvider fake: canned search results + canned fetched content. */
export class FakeSearch implements SearchProvider {
  public readonly searched: string[] = [];
  public readonly fetched: string[] = [];

  constructor(
    private readonly results: SearchResult[] = [],
    private readonly contentByUrl: Record<string, string> = {},
  ) {}

  async search(query: string): Promise<SearchResult[]> {
    this.searched.push(query);
    return this.results;
  }

  async fetchContent(url: string): Promise<string> {
    this.fetched.push(url);
    return this.contentByUrl[url] ?? `content of ${url}`;
  }
}
