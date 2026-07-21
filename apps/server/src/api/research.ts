// POST /api/research: the DIY research pipeline (plan.md sec 8).
//   search (Tavily) -> pick pages -> fetch content -> ONE summarization LLM call
//   that DIGESTS to a notebook note. Only the digested note leaves this handler --
//   raw page text is never returned or persisted (enforced here, not by prompt).
// All network goes through the injected SearchProvider + LlmProvider (mocked in tests).

import type { Context } from "hono";
import type { SearchResult, Usage } from "@yammer/shared";
import type { RouteDeps } from "./routes";
import { requireUser } from "../auth/session";
import { buildResearchPrompt, renderResearchInput } from "./prompt";

const MAX_PAGES = 3;

export async function handleResearch(
  c: Context,
  deps: RouteDeps,
): Promise<Response> {
  requireUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    queries?: unknown;
  } | null;

  const queries = body?.queries;
  if (
    !Array.isArray(queries) ||
    queries.length === 0 ||
    !queries.every((q) => typeof q === "string" && q.length > 0)
  ) {
    return c.json({ error: "queries (non-empty string[]) is required" }, 400);
  }

  // Search each query; dedupe results by URL, preserving first-seen order.
  const seen = new Set<string>();
  const collected: SearchResult[] = [];
  for (const query of queries as string[]) {
    const results = await deps.search.search(query);
    for (const r of results) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        collected.push(r);
      }
    }
  }

  // Pick the top pages (heuristic top-K; the digest step below is the load-bearing
  // "never dump raw pages" guarantee).
  const picked = collected.slice(0, MAX_PAGES);
  if (picked.length === 0) {
    return c.json({ error: "no search results found" }, 404);
  }

  // Fetch full content (inline from Tavily/Exa when present, else a fetch call).
  const pages: { title: string; url: string; content: string }[] = [];
  for (const r of picked) {
    const content = r.content ?? (await deps.search.fetchContent(r.url));
    pages.push({ title: r.title, url: r.url, content });
  }

  // One summarization call that digests the pages into a single note.
  const model = process.env.LLM_MODEL ?? "gpt-5.6-luna";
  const llmResult = await deps.llm.complete({
    system: buildResearchPrompt(),
    messages: [
      { role: "user", content: renderResearchInput(queries as string[], pages) },
    ],
    model,
  });

  const note = (llmResult.chatMessage ?? "").trim();
  if (!note) {
    throw new Error("Research summarization returned an empty note.");
  }

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
