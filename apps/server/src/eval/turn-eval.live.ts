// Gated live-API turn eval: exercises the REAL LLM on the golden cases in
// cases.ts. This file is named *.live.ts (NOT *.test.ts) so neither `pnpm test`
// nor the root suite nor CI ever discovers it -- it runs ONLY via the dedicated
// `pnpm --filter @yammer/server eval:live` config. It is additionally guarded at
// runtime: it SKIPS (never fails, never spends) unless BOTH YAMMER_LIVE=1 and
// OPENAI_API_KEY are set.
//
// Cost is hard-capped: a conservative projection is checked BEFORE every network
// call and the actual usage is metered after, both against YAMMER_LIVE_BUDGET_USD
// (default $0.50). The first breach aborts the remaining cases. Every run appends
// a summary line to <repoRoot>/test-costs.jsonl and prints a cost report.

import { afterAll, beforeAll, describe, it } from "vitest";

import { createLlmProvider } from "@yammer/providers";
import { parseLlmResponse } from "@yammer/core";
import type { LlmProvider } from "@yammer/shared";

import { buildSystemPrompt, renderUserMessage } from "../api/prompt";
import { cases, contextForCase, type TurnResult } from "./cases";
import {
  CostAccountant,
  DEFAULT_MODEL,
  costOf,
  defaultLedgerPath,
} from "./cost";

const live = process.env.YAMMER_LIVE === "1" && !!process.env.OPENAI_API_KEY;

if (!live) {
  const why =
    process.env.YAMMER_LIVE !== "1"
      ? "YAMMER_LIVE is not \"1\""
      : "OPENAI_API_KEY is not set";
  // One clear line so an operator running eval:live sees exactly why nothing spent.
  console.log(`[live-eval] SKIPPED -- ${why}. No API calls made, no spend.`);
}

const model = process.env.LLM_EVAL_MODEL ?? DEFAULT_MODEL;
const budgetUsd = Number(process.env.YAMMER_LIVE_BUDGET_USD ?? "0.50");

// Conservative pre-call token ceilings: ~3 chars/token (English averages ~4, so
// this over-counts input tokens) and a generous output ceiling for a structured
// turn. Over-estimating means the cap projection errs on the side of aborting.
const CONSERVATIVE_CHARS_PER_TOKEN = 3;
const CONSERVATIVE_OUTPUT_TOKENS = 600;

const suite = live ? describe : describe.skip;

suite("live LLM turn eval on the golden instruction cases", () => {
  const accountant = new CostAccountant(budgetUsd);
  let provider: LlmProvider;
  let aborted = false;

  beforeAll(() => {
    // Only reached when the suite actually runs (live === true), so the key is present.
    provider = createLlmProvider({ apiKey: process.env.OPENAI_API_KEY!, model });
  });

  for (const c of cases) {
    it(c.name, async () => {
      if (aborted) {
        throw new Error("live eval aborted on an earlier case (budget cap reached)");
      }

      const context = contextForCase(c);
      const system = buildSystemPrompt();
      const userMessage = renderUserMessage(context, c.transcript);

      // Project this call conservatively and refuse to make it if it could breach
      // the cap. A breach aborts the whole run, not just this case.
      const estInputTokens = Math.ceil(
        (system.length + userMessage.length) / CONSERVATIVE_CHARS_PER_TOKEN,
      );
      const projected = costOf(
        {
          sttSeconds: 0,
          inputTokens: estInputTokens,
          cachedInputTokens: 0,
          outputTokens: CONSERVATIVE_OUTPUT_TOKENS,
        },
        model,
      );
      try {
        accountant.assertWithin(projected);
      } catch (err) {
        aborted = true;
        throw err;
      }

      const result = await provider.complete({
        system,
        model,
        messages: [{ role: "user", content: userMessage }],
      });

      // Meter the ACTUAL spend against the cap (throws if it somehow breaches).
      try {
        accountant.add(result.usage, model);
      } catch (err) {
        aborted = true;
        throw err;
      }

      // Validate the envelope loudly -- an unparseable turn is a hard failure.
      const parsed = parseLlmResponse({
        chatMessage: result.chatMessage,
        actions: result.actions,
      });
      if (!parsed.ok) {
        throw new Error(
          `model returned an unparseable turn envelope for "${c.name}": ${parsed.error}`,
        );
      }

      const turn: TurnResult = {
        chatMessage: parsed.response.chatMessage ?? null,
        actions: parsed.response.actions,
      };
      c.assert(turn);
    });
  }

  afterAll(() => {
    const total = accountant.total();
    const count = accountant.count();
    const avg = count > 0 ? total / count : 0;

    accountant.appendLedger(defaultLedgerPath(), {
      timestamp: new Date().toISOString(),
      tier: "live-turn-eval",
      model,
      cases: count,
      totalUsd: total,
      avgUsdPerCase: avg,
      capUsd: budgetUsd,
    });

    console.log(
      `[live-eval] model=${model} cases=${count} ` +
        `total=$${total.toFixed(6)} avg=$${avg.toFixed(6)}/case ` +
        `cap=$${budgetUsd.toFixed(2)}`,
    );
  });
});
