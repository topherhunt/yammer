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

export interface CreateTestDbOptions {
  /**
   * Optional fault injector for atomicity tests: return true for the substituted
   * SQL of a statement that should throw instead of executing. Lets a test fail the
   * SECOND write of a transactional pair and assert the FIRST rolled back too.
   */
  failOn?: (sql: string) => boolean;
}

export function createTestDb(opts: CreateTestDbOptions = {}): TestContext {
  const mem = newDb();
  mem.public.none(INIT_SQL);

  const db: Database = drizzle(
    async (sqlText, params) => {
      const substituted = sqlText.replace(/\$(\d+)/g, (_m, d: string) =>
        toLiteral(params[Number(d) - 1]),
      );
      if (opts.failOn?.(substituted)) {
        throw new Error(`injected write fault for: ${substituted}`);
      }
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

  // The pg-proxy driver has no connection to BEGIN on, so its db.transaction()
  // throws -- but the repos rely on it for write atomicity. Back it with pg-mem's
  // snapshot/restore: take a backup before the callback and, on any throw, restore
  // it, giving the tests genuine all-or-nothing rollback. The repos never nest
  // transactions, so a single-level backup/restore is sufficient. The callback
  // receives `db` itself as the "tx" (same drizzle instance -> same pg-mem engine),
  // which is why repo queries run against the same in-memory state.
  (db as unknown as { transaction: TransactionFn }).transaction = async (cb) => {
    const backup = mem.backup();
    try {
      return await cb(db);
    } catch (err) {
      backup.restore();
      throw err;
    }
  };

  return { db, repos: createRepos(db) };
}

type TransactionFn = <T>(cb: (tx: Database) => Promise<T>) => Promise<T>;

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
