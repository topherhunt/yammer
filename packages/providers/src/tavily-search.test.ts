import { describe, it, expect, vi, afterEach } from "vitest";
import type { SearchResult } from "@yammer/shared";
import {
  createSearchProvider,
  MockSearchProvider,
  mapTavilyResult,
} from "./tavily-search";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Stub the runtime global fetch with a queued list of responses. */
function stubFetch(...responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = (responses[i++] ?? responses[responses.length - 1])!;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: "",
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return calls;
}

describe("mapTavilyResult", () => {
  it("maps content to snippet and raw_content to content", () => {
    const mapped = mapTavilyResult({
      title: "T",
      url: "https://a.com",
      content: "short snippet",
      raw_content: "the full cleaned page body",
    });
    expect(mapped).toEqual({
      title: "T",
      url: "https://a.com",
      snippet: "short snippet",
      content: "the full cleaned page body",
    });
  });

  it("leaves content undefined when Tavily returns no raw_content", () => {
    const mapped = mapTavilyResult({
      title: "T",
      url: "https://a.com",
      content: "snippet",
      raw_content: null,
    });
    expect(mapped.content).toBeUndefined();
    expect(mapped.snippet).toBe("snippet");
  });
});

describe("createSearchProvider.search", () => {
  it("posts the query with Bearer auth and maps Tavily results", async () => {
    const calls = stubFetch({
      body: {
        results: [
          { title: "One", url: "https://one.com", content: "snip one", raw_content: "body one" },
          { title: "Two", url: "https://two.com", content: "snip two" },
        ],
      },
    });
    const provider = createSearchProvider({ apiKey: "tvly-key" });
    const results = await provider.search("als voice editors");

    expect(calls[0]!.url).toBe("https://api.tavily.com/search");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tvly-key");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      query: "als voice editors",
      include_raw_content: true,
    });

    expect(results).toEqual([
      { title: "One", url: "https://one.com", snippet: "snip one", content: "body one" },
      { title: "Two", url: "https://two.com", snippet: "snip two", content: undefined },
    ]);
  });

  it("honors a custom baseUrl and strips a trailing slash", async () => {
    const calls = stubFetch({ body: { results: [] } });
    const provider = createSearchProvider({ apiKey: "k", baseUrl: "https://proxy.local/" });
    await provider.search("x");
    expect(calls[0]!.url).toBe("https://proxy.local/search");
  });

  it("surfaces a non-2xx response as an error including the status", async () => {
    stubFetch({ ok: false, status: 401, body: { detail: "bad key" } });
    const provider = createSearchProvider({ apiKey: "k" });
    await expect(provider.search("x")).rejects.toThrow(/Tavily \/search failed: 401/);
  });

  it("throws when the results array is missing", async () => {
    stubFetch({ body: { notResults: true } });
    const provider = createSearchProvider({ apiKey: "k" });
    await expect(provider.search("x")).rejects.toThrow(/missing a "results" array/);
  });
});

describe("createSearchProvider.fetchContent", () => {
  it("posts the url to /extract and returns the raw content", async () => {
    const calls = stubFetch({
      body: { results: [{ url: "https://one.com", raw_content: "extracted page text" }] },
    });
    const provider = createSearchProvider({ apiKey: "k" });
    const content = await provider.fetchContent("https://one.com");

    expect(calls[0]!.url).toBe("https://api.tavily.com/extract");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ urls: ["https://one.com"] });
    expect(content).toBe("extracted page text");
  });

  it("throws when extract returns no content for the url", async () => {
    stubFetch({ body: { results: [{ url: "https://one.com", raw_content: "" }] } });
    const provider = createSearchProvider({ apiKey: "k" });
    await expect(provider.fetchContent("https://one.com")).rejects.toThrow(
      /no content for https:\/\/one\.com/,
    );
  });
});

describe("MockSearchProvider", () => {
  const canned: SearchResult[] = [
    { title: "A", url: "https://a.com", snippet: "sa", content: "content a" },
    { title: "B", url: "https://b.com", snippet: "sb" },
  ];

  it("returns the canned results for any query", async () => {
    const provider = new MockSearchProvider(canned);
    expect(await provider.search("anything")).toEqual(canned);
  });

  it("fetchContent returns the content of the matching url", async () => {
    const provider = new MockSearchProvider(canned);
    expect(await provider.fetchContent("https://a.com")).toBe("content a");
  });

  it("throws when fetchContent has no canned result for the url", async () => {
    const provider = new MockSearchProvider(canned);
    await expect(provider.fetchContent("https://missing.com")).rejects.toThrow(
      /no canned result for url/,
    );
  });

  it("throws when the matching canned result has no content", async () => {
    const provider = new MockSearchProvider(canned);
    await expect(provider.fetchContent("https://b.com")).rejects.toThrow(/has no content/);
  });
});
