// Tavily adapter for the frozen @yammer/shared SearchProvider interface. Tavily
// is built for LLM agents: one /search call returns cleaned page content, so the
// DIY research pipeline (search -> pick -> fetch -> summarize) never has to scrape
// raw HTML. All Tavily-specific code stays inside this file.

import { type SearchProvider, type SearchResult } from "@yammer/shared";

/** Config for the real (Tavily) search provider. */
export interface SearchProviderConfig {
  apiKey: string;
  /** Override the API base URL (a proxy, tests). Defaults to Tavily's host. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.tavily.com";

// Shapes we read from Tavily responses. Kept local -- no Tavily types leak out.
interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  raw_content?: string | null;
}

interface TavilySearchResponse {
  results: TavilySearchResult[];
}

interface TavilyExtractResult {
  url: string;
  raw_content?: string | null;
}

interface TavilyExtractResponse {
  results: TavilyExtractResult[];
}

/** Map one Tavily result onto the shared SearchResult. `content` (the cleaned
 * snippet) becomes `snippet`; the fuller `raw_content`, when present, becomes
 * `content` so the pipeline can digest a page without a second fetch. */
export function mapTavilyResult(result: TavilySearchResult): SearchResult {
  return {
    title: result.title,
    url: result.url,
    snippet: result.content,
    content: result.raw_content ?? undefined,
  };
}

/** Build the default search provider (Tavily). Uses the runtime global `fetch`. */
export function createSearchProvider(
  config: SearchProviderConfig,
): SearchProvider {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Tavily ${path} failed: ${res.status} ${res.statusText}${detail ? ` -- ${detail}` : ""}`,
      );
    }
    return (await res.json()) as T;
  }

  return {
    async search(query: string): Promise<SearchResult[]> {
      const data = await post<TavilySearchResponse>("/search", {
        query,
        include_raw_content: true,
      });
      if (!Array.isArray(data.results)) {
        throw new Error('Tavily /search response is missing a "results" array');
      }
      return data.results.map(mapTavilyResult);
    },

    async fetchContent(url: string): Promise<string> {
      const data = await post<TavilyExtractResponse>("/extract", { urls: [url] });
      const first = data.results?.[0];
      if (!first || typeof first.raw_content !== "string" || first.raw_content === "") {
        throw new Error(`Tavily /extract returned no content for ${url}`);
      }
      return first.raw_content;
    },
  };
}

/**
 * A deterministic search provider for tests. Never hits a real search API.
 * `search` returns the canned results for any query; `fetchContent` returns the
 * `content` of the canned result whose url matches, throwing loudly if there is
 * no match or the match has no content -- so a test never silently gets stub text.
 */
export class MockSearchProvider implements SearchProvider {
  constructor(private readonly cannedResults: SearchResult[] = []) {}

  async search(_query: string): Promise<SearchResult[]> {
    return this.cannedResults;
  }

  async fetchContent(url: string): Promise<string> {
    const match = this.cannedResults.find((r) => r.url === url);
    if (!match) {
      throw new Error(`MockSearchProvider has no canned result for url ${url}`);
    }
    if (match.content === undefined || match.content === "") {
      throw new Error(`MockSearchProvider canned result for ${url} has no content`);
    }
    return match.content;
  }
}
