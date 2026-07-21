import { beforeAll, describe, it, expect } from "vitest";
import type { AppState } from "@yammer/shared";
import { initialState } from "@yammer/shared";
import { buildApp } from "../app";
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

describe("POST /api/turn", () => {
  it("applies an insert_text action, persists a version + turn, and returns the delta", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const llm = new FakeLlm([
      llmResult([{ type: "insert_text", position: "end", text: "Hello world" }], {
        chatMessage: "Added your sentence.",
        usage: { inputTokens: 200, cachedInputTokens: 50, outputTokens: 12 },
      }),
    ]);
    const app = buildApp({ repos, llm, search: new FakeSearch() });

    const res = await app.request("/api/turn", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ transcript: "add hello world", state: stateForDoc(doc), sttSeconds: 3 }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      chatMessage: string;
      actions: { type: string }[];
      state: AppState;
      usage: { sttSeconds: number; inputTokens: number };
    };
    expect(out.chatMessage).toBe("Added your sentence.");
    expect(out.actions[0]!.type).toBe("insert_text");
    expect(out.state.activeDocument!.text).toBe("Hello world");
    expect(out.usage).toEqual({ sttSeconds: 3, inputTokens: 200, cachedInputTokens: 50, outputTokens: 12 });

    // Version persisted (seq 1) and the document head advanced in the DB.
    const versions = await repos.versions.listForDocument(user.id, doc.id);
    expect(versions.map((v) => v.seq)).toEqual([0, 1]);
    expect((await repos.documents.get(user.id, doc.id))?.text).toBe("Hello world");

    // Turn persisted with transcript + usage for the spend meter.
    const turns = await repos.turns.listForDocument(user.id, doc.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.transcript).toBe("add hello world");
    expect(turns[0]!.usage.inputTokens).toBe(200);
  });

  it("surfaces an invalid model response as 422 and records a diagnostic turn", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const llm = new FakeLlm([llmResult([{ type: "not_a_real_action" }])]);
    const app = buildApp({ repos, llm, search: new FakeSearch() });

    const res = await app.request("/api/turn", {
      method: "POST",
      headers: jsonHeaders(user.id),
      body: JSON.stringify({ transcript: "do something", state: stateForDoc(doc) }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/Invalid model response/);

    const turns = await repos.turns.listForDocument(user.id, doc.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.actions).toEqual([]);
  });

  it("refuses a turn whose active document belongs to another user (404)", async () => {
    const { repos } = createTestDb();
    const alice = await seedUser(repos);
    const bob = await seedUser(repos);
    const aliceDoc = await repos.documents.create(alice.id, { name: "Alice Doc" });
    const llm = new FakeLlm([llmResult([])]);
    const app = buildApp({ repos, llm, search: new FakeSearch() });

    const res = await app.request("/api/turn", {
      method: "POST",
      headers: jsonHeaders(bob.id),
      body: JSON.stringify({ transcript: "edit it", state: stateForDoc(aliceDoc) }),
    });
    expect(res.status).toBe(404);
    // The LLM must not even be consulted for a document the caller cannot access.
    expect(llm.requests).toHaveLength(0);
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
