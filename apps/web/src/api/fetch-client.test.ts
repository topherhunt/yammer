import { afterEach, describe, expect, it, vi } from "vitest";
import type { SituationalContext, Version } from "@yammer/shared";
import { FetchApiClient } from "./fetch-client";
import { ApiError } from "./client";

// Drive FetchApiClient against a mocked global fetch: assert the URL, method,
// credentials, and body it sends, plus how it maps each response. No real
// network, no server -- this pins the HTTP contract the client speaks.

const BASE = "https://api.test";

/** A fetch stub that returns canned responses keyed by "METHOD path". */
function stubFetch(routes: Record<string, unknown>) {
  const calls: { url: string; method: string; body: unknown; credentials?: string }[] = [];
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.slice(BASE.length);
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      credentials: init?.credentials,
    });
    const key = `${method} ${path}`;
    if (!(key in routes)) {
      return { ok: false, status: 404, statusText: "Not Found" } as Response;
    }
    const payload = routes[key];
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => payload,
      blob: async () => new Blob([JSON.stringify(payload)]),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const emptyContext: SituationalContext = {
  document: null,
  visible: null,
  openDialog: null,
  activePanel: "chat",
  listening: "listening",
  chatSummary: "",
  recentChat: [],
  historySummary: "",
};

describe("FetchApiClient.turn", () => {
  it("POSTs transcript + context + documentId + sttSeconds and maps the LlmResult", async () => {
    const { calls } = stubFetch({
      "POST /api/turn": {
        chatMessage: "ok",
        actions: [{ type: "insert_text" }],
        usage: { sttSeconds: 2, inputTokens: 10, cachedInputTokens: 0, outputTokens: 3 },
        raw: { r: 1 },
      },
    });
    const client = new FetchApiClient(BASE);

    const result = await client.turn({
      transcript: "hello",
      context: emptyContext,
      documentId: "doc-1",
      sttSeconds: 2,
    });

    expect(result.chatMessage).toBe("ok");
    expect(result.actions).toEqual([{ type: "insert_text" }]);
    expect(result.usage.sttSeconds).toBe(2);

    const call = calls[0]!;
    expect(call.url).toBe("https://api.test/api/turn");
    expect(call.method).toBe("POST");
    expect(call.credentials).toBe("include");
    expect(call.body).toEqual({
      transcript: "hello",
      context: emptyContext,
      documentId: "doc-1",
      sttSeconds: 2,
    });
  });
});

describe("FetchApiClient.listDocuments", () => {
  it("GETs /api/documents with the sort query and returns the documents array", async () => {
    const docs = [{ id: "a", name: "A", createdAt: "2026-01-01", updatedAt: "2026-01-02" }];
    const { calls } = stubFetch({ "GET /api/documents?sort=name": { documents: docs } });
    const client = new FetchApiClient(BASE);

    const out = await client.listDocuments("name");
    expect(out).toEqual(docs);
    expect(calls[0]!.url).toBe("https://api.test/api/documents?sort=name");
  });
});

describe("FetchApiClient.getDocument", () => {
  it("by id: composes the document + versions endpoints into a payload", async () => {
    const document = { id: "d1", name: "Doc", text: "hi", currentVersionId: "v1", currentSeq: 1 };
    const versions = [{ id: "v0", seq: 0 }, { id: "v1", seq: 1 }];
    const { calls } = stubFetch({
      "GET /api/documents/d1": { document },
      "GET /api/documents/d1/versions": { versions },
    });
    const client = new FetchApiClient(BASE);

    const payload = await client.getDocument("d1");
    expect(payload.document).toEqual(document);
    expect(payload.history).toEqual(versions);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://api.test/api/documents/d1",
      "https://api.test/api/documents/d1/versions",
    ]);
  });

  it("by name: resolves via the list endpoint then fetches the matched id", async () => {
    const document = { id: "d2", name: "Report", text: "x", currentVersionId: "v1", currentSeq: 1 };
    stubFetch({
      "GET /api/documents": {
        documents: [
          { id: "d1", name: "Notes", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
          { id: "d2", name: "Report", createdAt: "2026-01-02", updatedAt: "2026-01-02" },
        ],
      },
      "GET /api/documents/d2": { document },
      "GET /api/documents/d2/versions": { versions: [] },
    });
    const client = new FetchApiClient(BASE);

    const payload = await client.getDocument(undefined, "Report");
    expect(payload.document.id).toBe("d2");
  });

  it("fails explicitly when no document matches byName", async () => {
    stubFetch({ "GET /api/documents": { documents: [] } });
    const client = new FetchApiClient(BASE);
    await expect(client.getDocument(undefined, "Missing")).rejects.toThrow(/No document named/);
  });
});

describe("FetchApiClient.renameDocument", () => {
  it("PATCHes /api/documents/:id with the new name", async () => {
    const { calls } = stubFetch({ "PATCH /api/documents/d1": { document: { id: "d1", name: "New" } } });
    const client = new FetchApiClient(BASE);

    await client.renameDocument("d1", "New");
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://api.test/api/documents/d1");
    expect(calls[0]!.body).toEqual({ name: "New" });
  });
});

describe("FetchApiClient.persistVersion", () => {
  it("POSTs the version to the document's versions endpoint", async () => {
    const version: Version = {
      id: "v1",
      documentId: "d1",
      seq: 1,
      parentVersionId: "v0",
      author: "ai",
      kind: "edit",
      summary: "edit",
      fullText: "hi",
      diff: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const { calls } = stubFetch({ "POST /api/documents/d1/versions": { version } });
    const client = new FetchApiClient(BASE);

    await client.persistVersion(version);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/api/documents/d1/versions");
    expect(calls[0]!.body).toEqual({ version });
  });

  it("includes undoStack/undoCursor in the body when the undo timeline is passed (N3)", async () => {
    const version: Version = {
      id: "v2",
      documentId: "d1",
      seq: 2,
      parentVersionId: "v1",
      author: "ai",
      kind: "edit",
      summary: "edit",
      fullText: "hi there",
      diff: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const { calls } = stubFetch({ "POST /api/documents/d1/versions": { version } });
    const client = new FetchApiClient(BASE);

    await client.persistVersion(version, { undoStack: ["v0", "v1", "v2"], undoCursor: 2 });
    expect(calls[0]!.body).toEqual({
      version,
      undoStack: ["v0", "v1", "v2"],
      undoCursor: 2,
    });
  });

  it("throws an ApiError carrying the numeric status on a non-2xx (for 409 branching)", async () => {
    const fn = vi.fn(async () => ({ ok: false, status: 409, statusText: "Conflict" }) as Response);
    vi.stubGlobal("fetch", fn);
    const version: Version = {
      id: "v1",
      documentId: "d1",
      seq: 1,
      parentVersionId: "v0",
      author: "ai",
      kind: "edit",
      summary: "edit",
      fullText: "hi",
      diff: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const client = new FetchApiClient(BASE);

    await client.persistVersion(version).then(
      () => {
        throw new Error("expected persistVersion to reject");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(409);
      },
    );
  });
});

describe("FetchApiClient.persistSettings", () => {
  it("PUTs /api/settings with the settings wrapper", async () => {
    const settings = {
      theme: "dark" as const,
      loadDocSort: "name" as const,
      sfxEnabled: true,
      silenceThresholdMs: 800,
      optimisticSendMs: 250,
      chatCompactThreshold: 20,
    };
    const { calls } = stubFetch({ "PUT /api/settings": { settings } });
    const client = new FetchApiClient(BASE);

    await client.persistSettings(settings);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.body).toEqual({ settings });
  });
});

describe("FetchApiClient.research", () => {
  it("POSTs queries and returns only the digested note", async () => {
    const { calls } = stubFetch({
      "POST /api/research": {
        note: "Digest of findings.",
        sources: [{ title: "T", url: "https://x" }],
        usage: {},
      },
    });
    const client = new FetchApiClient(BASE);

    const note = await client.research(["als assistive tech"]);
    expect(note).toBe("Digest of findings.");
    expect(calls[0]!.body).toEqual({ queries: ["als assistive tech"] });
  });
});

describe("FetchApiClient.exportDocx", () => {
  it("GETs the docx export as a Blob", async () => {
    const { calls } = stubFetch({ "GET /api/documents/d1/export?format=docx": { bytes: "x" } });
    const client = new FetchApiClient(BASE);

    const blob = await client.exportDocx("d1");
    expect(blob).toBeInstanceOf(Blob);
    expect(calls[0]!.url).toBe("https://api.test/api/documents/d1/export?format=docx");
    expect(calls[0]!.credentials).toBe("include");
  });
});

describe("error surfacing", () => {
  it("throws on a non-2xx response instead of silently degrading", async () => {
    stubFetch({}); // every route 404s
    const client = new FetchApiClient(BASE);
    await expect(client.listDocuments("updated")).rejects.toThrow(/failed: 404/);
  });
});
