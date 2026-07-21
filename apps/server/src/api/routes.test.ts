import { beforeAll, describe, it, expect } from "vitest";
import type { AppState, SituationalContext, Version } from "@yammer/shared";
import { initialState } from "@yammer/shared";
import { assembleContext } from "@yammer/core";
import { eq } from "drizzle-orm";
import { buildApp } from "../app";
import { documents } from "../db/schema";
import {
  authHeaders,
  createTestDb,
  FakeLlm,
  FakeSearch,
  llmResult,
  seedUser,
} from "../test-support";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-please-ignore";
});

function jsonHeaders(userId: string): Record<string, string> {
  return { ...authHeaders(userId), "content-type": "application/json" };
}

/** An AppState whose active document matches a repo-created document. */
function stateForDoc(doc: {
  id: string;
  name: string;
  text: string;
  currentVersionId: string;
  currentSeq: number;
}): AppState {
  return initialState({ activeDocument: { ...doc } });
}

/** The situational-context payload the client sends with a turn (thin relay). */
function contextForDoc(doc: {
  id: string;
  name: string;
  text: string;
  currentVersionId: string;
  currentSeq: number;
}): SituationalContext {
  return assembleContext(stateForDoc(doc));
}

/** A minimal edit Version appended by the client after applying the reducer. */
function editVersion(overrides: Partial<Version> & { documentId: string; seq: number }): Version {
  return {
    id: `v-${overrides.seq}`,
    parentVersionId: null,
    author: "ai",
    kind: "edit",
    summary: "edited",
    fullText: "",
    diff: [],
    createdAt: "2026-02-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("auth guard", () => {
  it("rejects unauthenticated access to data routes with 401", async () => {
    const { repos } = createTestDb();
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });
    const res = await app.request("/api/documents");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a tampered session cookie", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });
    const res = await app.request("/api/me", {
      headers: { cookie: `yammer_session=${user.id}.forgedsignature` },
    });
    expect(res.status).toBe(401);
  });
});

describe("documents CRUD", () => {
  it("creates, reads, lists, and renames a document for its owner", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const created = await app.request("/api/documents", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ name: "My Doc" }),
    });
    expect(created.status).toBe(201);
    const { document } = (await created.json()) as { document: { id: string; text: string } };
    expect(document.text).toBe("");

    const list = await app.request("/api/documents", { headers: authHeaders(user.id) });
    expect(((await list.json()) as { documents: unknown[] }).documents).toHaveLength(1);

    const renamed = await app.request(`/api/documents/${document.id}`, {
      method: "PATCH",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(((await renamed.json()) as { document: { name: string } }).document.name).toBe("Renamed");
  });

  it("returns 404 when reading another user's document", async () => {
    const { repos } = createTestDb();
    const alice = await seedUser(repos);
    const bob = await seedUser(repos);
    const doc = await repos.documents.create(alice.id, { name: "Alice Doc" });
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const res = await app.request(`/api/documents/${doc.id}`, { headers: authHeaders(bob.id) });
    expect(res.status).toBe(404);
  });
});

describe("settings", () => {
  it("returns defaults then persists an update", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const before = await app.request("/api/settings", { headers: authHeaders(user.id) });
    expect(((await before.json()) as { settings: { theme: string } }).settings.theme).toBe("system");

    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({
        settings: {
          theme: "dark",
          loadDocSort: "name",
          sfxEnabled: false,
          silenceThresholdMs: 900,
          optimisticSendMs: 300,
          chatCompactThreshold: 10,
        },
      }),
    });
    expect(((await put.json()) as { settings: { theme: string } }).settings.theme).toBe("dark");

    const after = await app.request("/api/settings", { headers: authHeaders(user.id) });
    expect(((await after.json()) as { settings: { sfxEnabled: boolean } }).settings.sfxEnabled).toBe(false);
  });

  it("rejects an invalid settings payload with 400", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ settings: { theme: "neon" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/turn (thin relay)", () => {
  it("relays the raw LLM envelope + usage and does NOT itself apply or persist a version", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const llm = new FakeLlm([
      llmResult([{ type: "insert_text", position: "end", text: "Hello world" }], {
        chatMessage: "Added your sentence.",
        usage: { inputTokens: 200, cachedInputTokens: 50, outputTokens: 12 },
        raw: { model_said: "hi" },
      }),
    ]);
    const app = buildApp({ repos, llm, search: new FakeSearch() });

    const res = await app.request("/api/turn", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({
        transcript: "add hello world",
        context: contextForDoc(doc),
        documentId: doc.id,
        sttSeconds: 3,
      }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      chatMessage: string;
      actions: { type: string }[];
      usage: { sttSeconds: number; inputTokens: number };
      raw: { model_said: string };
      state?: unknown;
    };
    // Raw, UNvalidated actions come straight back for the client to apply.
    expect(out.chatMessage).toBe("Added your sentence.");
    expect(out.actions[0]!.type).toBe("insert_text");
    expect(out.raw.model_said).toBe("hi");
    expect(out.usage).toEqual({ sttSeconds: 3, inputTokens: 200, cachedInputTokens: 50, outputTokens: 12 });
    // The relay does not run the reducer, so there is no applied state delta.
    expect(out.state).toBeUndefined();

    // The relay persists NO version -- only the seq-0 create remains, head unchanged.
    const versions = await repos.versions.listForDocument(user.id, doc.id);
    expect(versions.map((v) => v.seq)).toEqual([0]);
    expect((await repos.documents.get(user.id, doc.id))?.text).toBe("");

    // A diagnostic Turn IS logged for the owned document (chat sidebar + spend meter).
    const turns = await repos.turns.listForDocument(user.id, doc.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.transcript).toBe("add hello world");
    expect(turns[0]!.usage.inputTokens).toBe(200);
    expect(turns[0]!.chatMessage).toBe("Added your sentence.");
  });

  it("still relays raw actions when the model output is invalid, logging [] actions", async () => {
    // The client is authoritative and re-validates, so the relay does not 4xx on a
    // bad envelope -- it hands the raw actions back and logs an empty action set.
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const llm = new FakeLlm([llmResult([{ type: "not_a_real_action" }], { raw: { junk: true } })]);
    const app = buildApp({ repos, llm, search: new FakeSearch() });

    const res = await app.request("/api/turn", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ transcript: "do something", context: contextForDoc(doc), documentId: doc.id }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { actions: { type: string }[] };
    expect(out.actions[0]!.type).toBe("not_a_real_action");

    // The logged Turn records [] actions (parse failed) but keeps the raw response.
    const turns = await repos.turns.listForDocument(user.id, doc.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.actions).toEqual([]);
    expect(turns[0]!.llmRawResponse).toEqual({ junk: true });
  });

  it("returns 502 when the LLM provider throws", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const llm = new FakeLlm([]); // drained -> complete() throws
    const app = buildApp({ repos, llm, search: new FakeSearch() });

    const res = await app.request("/api/turn", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ transcript: "hi", context: contextForDoc(doc), documentId: doc.id }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/LLM request failed/);
    // Nothing was logged for a turn that never produced a response.
    expect(await repos.turns.listForDocument(user.id, doc.id)).toHaveLength(0);
  });

  it("does not log a diagnostic Turn for a document the caller does not own", async () => {
    const { repos } = createTestDb();
    const alice = await seedUser(repos);
    const bob = await seedUser(repos);
    const aliceDoc = await repos.documents.create(alice.id, { name: "Alice Doc" });
    const llm = new FakeLlm([llmResult([])]);
    const app = buildApp({ repos, llm, search: new FakeSearch() });

    const res = await app.request("/api/turn", {
      method: "POST",
      headers: jsonHeaders(bob.id),
      body: JSON.stringify({ transcript: "edit it", context: contextForDoc(aliceDoc), documentId: aliceDoc.id }),
    });
    expect(res.status).toBe(200);
    // Per-user isolation: bob's relayed turn writes nothing to alice's diagnostics.
    expect(await repos.turns.listForDocument(alice.id, aliceDoc.id)).toHaveLength(0);
  });
});

describe("POST /api/documents/:id/versions (client-authoritative persistence)", () => {
  it("appends the client's version and advances the document head", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const version = editVersion({
      documentId: doc.id,
      seq: 1,
      parentVersionId: doc.currentVersionId,
      fullText: "Hello world",
      summary: "wrote hello",
    });

    const res = await app.request(`/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ version }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { version: { id: string } }).version.id).toBe("v-1");

    const head = await repos.documents.get(user.id, doc.id);
    expect(head?.text).toBe("Hello world");
    expect(head?.currentSeq).toBe(1);
    expect(head?.currentVersionId).toBe("v-1");
    expect((await repos.versions.listForDocument(user.id, doc.id)).map((v) => v.seq)).toEqual([0, 1]);
  });

  it("persists the client's undo timeline when supplied", async () => {
    const { db, repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const version = editVersion({ documentId: doc.id, seq: 1, parentVersionId: doc.currentVersionId, fullText: "x" });
    await app.request(`/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ version, undoStack: [doc.currentVersionId, "v-1"], undoCursor: 1 }),
    });

    const rows = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(rows[0]!.undoStack).toEqual([doc.currentVersionId, "v-1"]);
    expect(rows[0]!.undoCursor).toBe(1);
  });

  it("is idempotent: re-posting the same version id is a no-op success", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const version = editVersion({ documentId: doc.id, seq: 1, parentVersionId: doc.currentVersionId, fullText: "once" });
    const body = JSON.stringify({ version });

    const first = await app.request(`/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: jsonHeaders(user.id),
      body,
    });
    expect(first.status).toBe(201);
    const second = await app.request(`/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: jsonHeaders(user.id),
      body,
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { version: { fullText: string } }).version.fullText).toBe("once");

    // No double-append: the history still has exactly seq 0 and 1.
    expect((await repos.versions.listForDocument(user.id, doc.id)).map((v) => v.seq)).toEqual([0, 1]);
  });

  it("rejects a seq that is not head + 1 with 409 (reused seq under a different id)", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    await app.request(`/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ version: editVersion({ id: "v-a", documentId: doc.id, seq: 1, fullText: "a" }) }),
    });

    // A different id trying to claim seq 1 again (head is now 1) is a conflict.
    const dup = await app.request(`/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ version: editVersion({ id: "v-b", documentId: doc.id, seq: 1, fullText: "b" }) }),
    });
    expect(dup.status).toBe(409);

    // A gap (seq 3 when head is 1) is likewise rejected.
    const gap = await app.request(`/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ version: editVersion({ id: "v-c", documentId: doc.id, seq: 3, fullText: "c" }) }),
    });
    expect(gap.status).toBe(409);

    // Head is unchanged: only seq 0 and the first appended seq 1 survive.
    expect((await repos.versions.listForDocument(user.id, doc.id)).map((v) => v.seq)).toEqual([0, 1]);
  });

  it("returns 404 when persisting to another user's document", async () => {
    const { repos } = createTestDb();
    const alice = await seedUser(repos);
    const bob = await seedUser(repos);
    const aliceDoc = await repos.documents.create(alice.id, { name: "Alice Doc" });
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const res = await app.request(`/api/documents/${aliceDoc.id}/versions`, {
      method: "POST",
      headers: jsonHeaders(bob.id),
      body: JSON.stringify({
        version: editVersion({ documentId: aliceDoc.id, seq: 1, fullText: "hijack" }),
      }),
    });
    expect(res.status).toBe(404);
    // Alice's history is untouched.
    expect((await repos.versions.listForDocument(alice.id, aliceDoc.id)).map((v) => v.seq)).toEqual([0]);
  });
});

describe("POST /api/research", () => {
  it("digests fetched pages into a note and never returns raw page text", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const search = new FakeSearch([
      { title: "ALS Overview", url: "https://ex.com/a", snippet: "s1", content: "RAW-PAGE-BODY-A" },
      { title: "Speech Devices", url: "https://ex.com/b", snippet: "s2" },
    ], { "https://ex.com/b": "RAW-PAGE-BODY-B" });
    const llm = new FakeLlm([
      llmResult([], { chatMessage: "Digest: ALS affects motor neurons; speech devices help." }),
    ]);
    const app = buildApp({ repos, llm, search });

    const res = await app.request("/api/research", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ queries: ["ALS assistive tech"] }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      note: string;
      sources: { title: string; url: string }[];
    };
    expect(out.note).toMatch(/Digest: ALS affects motor neurons/);
    expect(out.sources.map((s) => s.url)).toEqual(["https://ex.com/a", "https://ex.com/b"]);

    // The raw page bodies must not leak into the response.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("RAW-PAGE-BODY-A");
    expect(serialized).not.toContain("RAW-PAGE-BODY-B");

    // Page B had no inline content, so it was fetched; page A's inline content was reused.
    expect(search.fetched).toEqual(["https://ex.com/b"]);
  });
});

describe("export + diagnostics", () => {
  it("exports raw markdown with a download disposition", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "My Notes" });
    await repos.versions.append(user.id, {
      id: "vexp",
      documentId: doc.id,
      seq: 1,
      parentVersionId: doc.currentVersionId,
      author: "user",
      kind: "edit",
      summary: "wrote",
      fullText: "# Title\n\nbody text",
      diff: [],
      createdAt: new Date().toISOString(),
    });
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const res = await app.request(`/api/documents/${doc.id}/export?format=md`, {
      headers: authHeaders(user.id),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("My_Notes.md");
    expect(await res.text()).toBe("# Title\n\nbody text");
  });

  it("serializes turns + version history into the diagnostics payload", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    await repos.turns.append(user.id, {
      id: "td1",
      userId: user.id,
      documentId: doc.id,
      createdAt: "2026-02-02T00:00:00.000Z",
      transcript: "hello",
      sttMeta: null,
      llmModel: "gpt-5.6-luna",
      llmRawResponse: { r: 1 },
      actions: [],
      usage: { sttSeconds: 1, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 },
    });
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const res = await app.request(`/api/documents/${doc.id}/diagnostics`, {
      headers: authHeaders(user.id),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      turns: { transcript: string }[];
      versions: { seq: number }[];
    };
    expect(out.turns[0]!.transcript).toBe("hello");
    expect(out.versions.map((v) => v.seq)).toEqual([0]);
  });
});
