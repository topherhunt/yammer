import { beforeAll, describe, it, expect } from "vitest";
import type {
  AppState,
  SearchProvider,
  SearchResult,
  SituationalContext,
  Version,
} from "@yammer/shared";
import { initialState } from "@yammer/shared";
import { assembleContext } from "@yammer/core";
import { eq } from "drizzle-orm";
import { buildApp } from "../app";
import { documents, versions } from "../db/schema";
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

  it("rejects creating a document whose name duplicates an existing one (case-insensitive) with 409", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const first = await app.request("/api/documents", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ name: "Journal" }),
    });
    expect(first.status).toBe(201);

    const dup = await app.request("/api/documents", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ name: "journal" }),
    });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toMatch(/already exists/);
    // No duplicate was created -- the user still has exactly one document.
    const list = await app.request("/api/documents", { headers: authHeaders(user.id) });
    expect(((await list.json()) as { documents: unknown[] }).documents).toHaveLength(1);
  });

  it("rejects renaming a document onto another document's name (case-insensitive) with 409", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    await repos.documents.create(user.id, { name: "Journal" });
    const notes = await repos.documents.create(user.id, { name: "Notes" });
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const res = await app.request(`/api/documents/${notes.id}`, {
      method: "PATCH",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ name: "JOURNAL" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already exists/);
    // The rename did not take: "Notes" is unchanged.
    expect((await repos.documents.get(user.id, notes.id))?.name).toBe("Notes");
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

  it("rejects a malformed context ({}) with 400 -- before any LLM call, not a 500", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    // Drained: if the handler reached the provider it would 502, not 400. A 400 here
    // proves validation short-circuits before any (paid) LLM call.
    const app = buildApp({ repos, llm: new FakeLlm([]), search: new FakeSearch() });

    const res = await app.request("/api/turn", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ transcript: "hello", context: {}, documentId: doc.id }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/SituationalContext/);
    // No diagnostic Turn logged for a request that never ran.
    expect(await repos.turns.listForDocument(user.id, doc.id)).toHaveLength(0);
  });

  it("rejects a missing transcript with 400", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const app = buildApp({ repos, llm: new FakeLlm([]), search: new FakeSearch() });

    const res = await app.request("/api/turn", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ context: contextForDoc(doc), documentId: doc.id }),
    });
    expect(res.status).toBe(400);
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

  it("create-then-save round-trip: POST /api/documents returns the create version, then an edit saves against it", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    // Create through the HTTP API exactly as the client now does.
    const created = await app.request("/api/documents", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ name: "Fresh" }),
    });
    expect(created.status).toBe(201);
    const { document, history } = (await created.json()) as {
      document: { id: string; currentVersionId: string; currentSeq: number };
      history: { seq: number; kind: string }[];
    };
    // The response carries the seq-0 create version so the client adopts the base
    // without a second round-trip (and without minting its own version 0).
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ seq: 0, kind: "create" });
    expect(document.currentSeq).toBe(0);

    // A subsequent edit (seq 1) saves against the now-existing document -- the exact
    // path that used to 404 forever because creation never happened server-side.
    const version = editVersion({
      documentId: document.id,
      seq: 1,
      parentVersionId: document.currentVersionId,
      fullText: "typed words",
      summary: "typed",
    });
    const saved = await app.request(`/api/documents/${document.id}/versions`, {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ version }),
    });
    expect(saved.status).toBe(201);
    expect(
      (await repos.versions.listForDocument(user.id, document.id)).map((v) => v.seq),
    ).toEqual([0, 1]);
  });

  it("a version save to a never-created document is a clean 404 (creation must happen first)", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const version = editVersion({ documentId: "ghost-doc", seq: 1, fullText: "x" });
    const res = await app.request("/api/documents/ghost-doc/versions", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ version }),
    });
    expect(res.status).toBe(404);
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

  it("rejects a malformed version envelope with 400, persisting nothing", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    // Only id/seq/documentId present -- the old code cast the rest straight to
    // Version and would 500 or persist an inconsistent snapshot. versionSchema now
    // rejects it as a clean 400.
    const res = await app.request(`/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ version: { id: "v-bad", seq: 1, documentId: doc.id } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid version/);

    // Nothing was persisted: only the seq-0 create survives, head unmoved.
    expect(
      (await repos.versions.listForDocument(user.id, doc.id)).map((v) => v.seq),
    ).toEqual([0]);
    expect(await repos.versions.get(user.id, "v-bad")).toBeNull();
  });

  it("rejects a version with a null fullText (the NULL-column 500) with 400", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const res = await app.request(`/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({
        version: editVersion({
          documentId: doc.id,
          seq: 1,
          fullText: null as unknown as string,
        }),
      }),
    });
    expect(res.status).toBe(400);
    expect(
      (await repos.versions.listForDocument(user.id, doc.id)).map((v) => v.seq),
    ).toEqual([0]);
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

  it("maps a concurrent UNIQUE(document_id, seq) collision to the structured 409, not a 500", async () => {
    const { db, repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    // Simulate a concurrent winner: a versions row already occupies (doc, seq 1) at
    // the DB level, but the document HEAD is still seq 0 (this request's view is
    // stale). The route's seq === head+1 check therefore passes (0+1 === 1), so the
    // collision can only surface as the DB unique violation -- which must become the
    // same { error, expectedSeq } 409, never an opaque 500.
    await db.insert(versions).values({
      id: "v-winner",
      userId: user.id,
      documentId: doc.id,
      seq: 1,
      parentVersionId: doc.currentVersionId,
      author: "ai",
      kind: "edit",
      summary: "winner",
      fullText: "winner",
      diff: [],
      createdAt: "2026-02-02T00:00:00.000Z",
      restoredFromVersionId: null,
    });

    const res = await app.request(`/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({
        version: editVersion({
          id: "v-loser",
          documentId: doc.id,
          seq: 1,
          parentVersionId: doc.currentVersionId,
          fullText: "loser",
        }),
      }),
    });
    expect(res.status).toBe(409);
    const out = (await res.json()) as { error: string; expectedSeq: number };
    expect(out.error).toMatch(/seq conflict/);
    expect(typeof out.expectedSeq).toBe("number");

    // The losing append wrote nothing: only the seq-0 create and the winner survive.
    const seqs = (await repos.versions.listForDocument(user.id, doc.id)).map((v) => v.seq);
    expect(seqs).toEqual([0, 1]);
    expect(await repos.versions.get(user.id, "v-loser")).toBeNull();
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

  it("rejects more than 5 queries with 400 and never touches the search provider", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const search = new FakeSearch([{ title: "t", url: "https://ex.com/x", snippet: "s" }]);
    // FakeLlm/FakeSearch are drained: any provider call would throw, proving the cap
    // rejects BEFORE any paid fan-out happens.
    const app = buildApp({ repos, llm: new FakeLlm(), search });

    const res = await app.request("/api/research", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ queries: ["a", "b", "c", "d", "e", "f"] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/1-5/);
    expect(search.searched).toEqual([]);
  });

  it("rejects an over-long query with 400", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const res = await app.request("/api/research", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ queries: ["x".repeat(201)] }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts the boundary: exactly 5 queries of 200 chars each", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const search = new FakeSearch([
      { title: "T", url: "https://ex.com/a", snippet: "s", content: "BODY" },
    ]);
    const llm = new FakeLlm([llmResult([], { chatMessage: "Digested note." })]);
    const app = buildApp({ repos, llm, search });

    const res = await app.request("/api/research", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ queries: Array.from({ length: 5 }, () => "q".repeat(200)) }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { note: string }).note).toBe("Digested note.");
  });

  it("dedupes results by URL across queries, digesting each URL only once", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    // The same two results come back for BOTH queries. After dedupe the note must
    // cite each URL exactly once -- the duplicate second-query hits are dropped.
    const search = new FakeSearch([
      { title: "A", url: "https://ex.com/a", snippet: "s", content: "BODY-A" },
      { title: "B", url: "https://ex.com/b", snippet: "s", content: "BODY-B" },
    ]);
    const llm = new FakeLlm([llmResult([], { chatMessage: "Merged digest." })]);
    const app = buildApp({ repos, llm, search });

    const res = await app.request("/api/research", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ queries: ["als tech", "als devices"] }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { sources: { url: string }[] };
    // Both queries were searched, but the two URLs appear once each (not four rows).
    expect(search.searched).toEqual(["als tech", "als devices"]);
    expect(out.sources.map((s) => s.url)).toEqual(["https://ex.com/a", "https://ex.com/b"]);
  });

  it("caps the digested pages to MAX_PAGES (3) even when more results come back", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    // Five distinct results; only the first three may be fetched + summarized.
    const search = new FakeSearch(
      Array.from({ length: 5 }, (_, i) => ({
        title: `T${i}`,
        url: `https://ex.com/${i}`,
        snippet: "s",
        content: `BODY-${i}`,
      })),
    );
    const llm = new FakeLlm([llmResult([], { chatMessage: "Top-three digest." })]);
    const app = buildApp({ repos, llm, search });

    const res = await app.request("/api/research", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ queries: ["broad query"] }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { sources: { url: string }[] };
    // Exactly the first three URLs are cited; results 4 and 5 are dropped by the cap.
    expect(out.sources.map((s) => s.url)).toEqual([
      "https://ex.com/0",
      "https://ex.com/1",
      "https://ex.com/2",
    ]);
    // Only one digest LLM call was made over those three pages.
    expect(llm.requests).toHaveLength(1);
  });

  it("returns ONLY the note, sources, and usage -- no raw pages or extra fields", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const search = new FakeSearch([
      { title: "Only", url: "https://ex.com/only", snippet: "s", content: "SECRET-BODY" },
    ]);
    const llm = new FakeLlm([
      llmResult([], {
        chatMessage: "The findings note.",
        usage: { inputTokens: 40, cachedInputTokens: 10, outputTokens: 8 },
      }),
    ]);
    const app = buildApp({ repos, llm, search });

    const res = await app.request("/api/research", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ queries: ["q"] }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      note: string;
      sources: { title: string; url: string }[];
      usage: { sttSeconds: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
    };
    // The response surface is exactly these three keys -- nothing leaks the raw page.
    expect(Object.keys(out).sort()).toEqual(["note", "sources", "usage"]);
    expect(out.note).toBe("The findings note.");
    expect(out.sources).toEqual([{ title: "Only", url: "https://ex.com/only" }]);
    // usage is the LLM digest's token spend, with sttSeconds pinned to 0 (no audio).
    expect(out.usage).toEqual({ sttSeconds: 0, inputTokens: 40, cachedInputTokens: 10, outputTokens: 8 });
    expect(JSON.stringify(out)).not.toContain("SECRET-BODY");
  });

  it("returns 404 when the search yields no results, never calling the digest LLM", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const search = new FakeSearch([]); // every query comes back empty
    const llm = new FakeLlm([]); // drained: a digest call would throw
    const app = buildApp({ repos, llm, search });

    const res = await app.request("/api/research", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ queries: ["nothing matches this"] }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/no search results/);
    // The search WAS attempted, but no page was digested (LLM untouched).
    expect(search.searched).toEqual(["nothing matches this"]);
    expect(llm.requests).toHaveLength(0);
  });

  it("surfaces an empty digest note as a 502, not an opaque 500", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const search = new FakeSearch([
      { title: "T", url: "https://ex.com/a", snippet: "s", content: "BODY" },
    ]);
    // The model returns only whitespace -> nothing usable to digest.
    const llm = new FakeLlm([llmResult([], { chatMessage: "   " })]);
    const app = buildApp({ repos, llm, search });

    const res = await app.request("/api/research", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ queries: ["q"] }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/empty note/);
  });

  it("maps a search-provider rejection to a 502, not an unhandled 500", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    // A provider whose search() rejects (e.g. Tavily down). The digest LLM is drained
    // so it would throw if reached -- proving the failure is caught at the search step.
    const boomSearch: SearchProvider = {
      search: async () => {
        throw new Error("tavily upstream 503");
      },
      fetchContent: async () => "unused",
    };
    const llm = new FakeLlm([]);
    const app = buildApp({ repos, llm, search: boomSearch });

    const res = await app.request("/api/research", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ queries: ["als"] }),
    });
    expect(res.status).toBe(502);
    const out = (await res.json()) as { error: string };
    expect(out.error).toMatch(/web search failed/);
    expect(out.error).toMatch(/tavily upstream 503/);
    expect(llm.requests).toHaveLength(0);
  });

  it("maps a fetchContent rejection (page with no inline content) to a 502", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    // Result has NO inline content, so the handler falls back to fetchContent -- which
    // here rejects. That must surface as a 502, not an opaque 500.
    const results: SearchResult[] = [{ title: "T", url: "https://ex.com/a", snippet: "s" }];
    const boomFetch: SearchProvider = {
      search: async () => results,
      fetchContent: async () => {
        throw new Error("extractor timeout");
      },
    };
    const llm = new FakeLlm([]);
    const app = buildApp({ repos, llm, search: boomFetch });

    const res = await app.request("/api/research", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ queries: ["q"] }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/fetching page content failed/);
    expect(llm.requests).toHaveLength(0);
  });
});

describe("request body-size limit", () => {
  it("returns 413 for a body over the 5 MB /api cap", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    // A ~6 MB name blows past the 5 MB cap; the middleware rejects before the handler.
    const oversized = "x".repeat(6 * 1024 * 1024);
    const res = await app.request("/api/documents", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ name: oversized }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/too large/);

    // Nothing was persisted.
    const list = await app.request("/api/documents", { headers: authHeaders(user.id) });
    expect(((await list.json()) as { documents: unknown[] }).documents).toHaveLength(0);
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
