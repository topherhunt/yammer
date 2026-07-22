// POST /api/research: the DIY research pipeline (plan.md sec 8).
//   search (Tavily) -> pick pages -> fetch content -> ONE summarization LLM call
//   that DIGESTS to a notebook note. Only the digested note leaves this handler --
//   raw page text is never returned or persisted (enforced here, not by prompt).
// All network goes through the injected SearchProvider + LlmProvider (mocked in tests).

import type { Context } from "hono";
import type { SearchResult, Usage } from "@yammer/shared";
import type { RouteDeps } from "./routes";
import { requireUser } from "../auth/session";
import { debugLog } from "../debug";
import { buildResearchPrompt, renderResearchInput } from "./prompt";
import {
  MAX_RESEARCH_QUERIES,
  MAX_RESEARCH_QUERY_LENGTH,
  researchRequestSchema,
} from "./validation";

const MAX_PAGES = 3;

export async function handleResearch(
  c: Context,
  deps: RouteDeps,
): Promise<Response> {
  requireUser(c);
  const body = (await c.req.json().catch(() => null)) as unknown;

  // Bounded fan-out: 1..MAX_RESEARCH_QUERIES queries, each 1..MAX length. This is
  // the real-dollar guardrail -- an unbounded array would fan out paid API calls.
  const parsed = researchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: `queries must be 1-${MAX_RESEARCH_QUERIES} non-empty strings, each at most ${MAX_RESEARCH_QUERY_LENGTH} chars`,
        detail: parsed.error.issues,
      },
      400,
    );
  }
  const queries = parsed.data.queries;

  // Search each query; dedupe results by URL, preserving first-seen order. A search
  // provider rejection is surfaced as a 502 (mirrors handleTurn's LLM-failure path)
  // rather than falling through to an opaque 500 -- the client cannot digest results
  // it never received.
  const seen = new Set<string>();
  const collected: SearchResult[] = [];
  const searchErrors: string[] = [];
  // Tolerant per query: one query's search failing (e.g. a transient Tavily 503)
  // must not sink the whole request when other queries succeed.
  for (const query of queries) {
    try {
      const results = await deps.search.search(query);
      for (const r of results) {
        if (!seen.has(r.url)) {
          seen.add(r.url);
          collected.push(r);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog("research", { stage: "search", query, error: message });
      searchErrors.push(message);
    }
  }
  // Only a hard failure if EVERY search failed and nothing came back.
  if (collected.length === 0) {
    if (searchErrors.length > 0) {
      return c.json({ error: `web search failed: ${searchErrors[0]}` }, 502);
    }
    return c.json({ error: "no search results found" }, 404);
  }

  // Pick the top pages (heuristic top-K; the digest step below is the load-bearing
  // "never dump raw pages" guarantee).
  const picked = collected.slice(0, MAX_PAGES);
  if (picked.length === 0) {
    return c.json({ error: "no search results found" }, 404);
  }

  // Fetch full content (inline from Tavily/Exa when present, else a fetch call). A
  // fetch rejection is likewise a 502, not a swallowed/opaque failure.
  // Tolerant per page: a page that blocks scrapers, times out, or returns no
  // content (e.g. researchgate) is SKIPPED, not fatal -- we digest whatever we got.
  const pages: { title: string; url: string; content: string }[] = [];
  for (const r of picked) {
    try {
      const content = r.content ?? (await deps.search.fetchContent(r.url));
      if (content && content.trim()) {
        pages.push({ title: r.title, url: r.url, content });
      }
    } catch (err) {
      debugLog("research", {
        stage: "fetch",
        url: r.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (pages.length === 0) {
    return c.json(
      { error: "no page content could be fetched from the search results" },
      502,
    );
  }

  // One summarization call that digests the pages into a single note. A provider
  // failure here is a 502 too (nothing usable to return).
  const model = process.env.LLM_MODEL ?? "gpt-5.6-luna";
  let llmResult;
  try {
    llmResult = await deps.llm.complete({
      system: buildResearchPrompt(),
      messages: [
        { role: "user", content: renderResearchInput(queries, pages) },
      ],
      model,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog("research", { stage: "digest", error: message });
    return c.json({ error: `research digest failed: ${message}` }, 502);
  }

  // An empty/whitespace digest means the model returned nothing usable: surface it
  // as an explicit 502 (a bad upstream response), not an opaque thrown 500.
  const note = (llmResult.chatMessage ?? "").trim();
  if (!note) {
    return c.json({ error: "research digest returned an empty note" }, 502);
  }
  // Log the successful result so the debug file is complete (the digested note is
  // otherwise only visible in the chat sidebar).
  debugLog("research", {
    stage: "done",
    queries,
    pages: pages.length,
    note,
  });

  const usage: Usage = {
    sttSeconds: 0,
    inputTokens: llmResult.usage.inputTokens,
    cachedInputTokens: llmResult.usage.cachedInputTokens,
    outputTokens: llmResult.usage.outputTokens,
  };

  // Return only the digested note + source references. Never the raw page text.
  return c.json({
    note,
    sources: picked.map((r) => ({ title: r.title, url: r.url })),
    usage,
  });
}
