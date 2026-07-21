// Pure, dependency-free (node builtins only) cost accounting for the live-API
// eval tier. Prices a Usage block against a per-model rate table, accumulates
// spend across a run, and enforces a hard budget cap that throws BEFORE any
// individual call is allowed to push cumulative cost past the cap. Deterministic:
// no Date.now / randomness here -- timestamps are injected by the caller so the
// ledger line is reproducible under test.

import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Usage } from "@yammer/shared";

/** USD rates for one model. Token rates are per 1,000,000 tokens; STT is per audio minute. */
export interface Pricing {
  /** USD / 1M non-cached input tokens. */
  input: number;
  /** USD / 1M cached input tokens -- the ~90% cached-input discount (10% of `input`). */
  cachedInput: number;
  /** USD / 1M output tokens. */
  output: number;
  /** USD / audio minute for streaming STT. */
  sttPerMin: number;
}

// Rate table (USD). cachedInput encodes the 90% cached-input discount (a tenth of
// the input rate). Numbers mirror the reference costs in CLAUDE.md.
// The "default" row is the documented fallback used when a model id is not in the
// table: it equals Luna, the dev default, so an unrecognized id is priced (and
// budgeted) as the cheap dev model rather than crashing a run mid-flight.
export const PRICING: Record<string, Pricing> = {
  "gpt-5.6-luna": { input: 1, cachedInput: 0.1, output: 6, sttPerMin: 0.017 },
  "gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, output: 15, sttPerMin: 0.017 },
  default: { input: 1, cachedInput: 0.1, output: 6, sttPerMin: 0.017 },
};

/** The dev-default model id -- also the model the "default" pricing row mirrors. */
export const DEFAULT_MODEL = "gpt-5.6-luna";

/** Hard budget cap used when YAMMER_LIVE_BUDGET_USD is unset/empty. */
export const DEFAULT_BUDGET_USD = 0.5;

/**
 * Parse + validate the live-eval budget cap from its env string. Fails loudly on a
 * present-but-invalid value (NaN, non-positive) instead of silently proceeding with
 * a bad cap that would later crash CostAccountant. Falls back to DEFAULT_BUDGET_USD
 * when unset/empty. Kept here (not at eval module scope) so the eval's skip path can
 * defer calling it -- a bad env value must never crash the no-spend describe.skip.
 */
export function parseBudgetUsd(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_BUDGET_USD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid YAMMER_LIVE_BUDGET_USD: expected a positive USD amount, got "${raw}"`,
    );
  }
  return value;
}

/** Rates for `model`, falling back to the documented `default` row for unknown ids. */
export function pricingFor(model: string): Pricing {
  return PRICING[model] ?? PRICING.default!;
}

/**
 * USD cost of a single Usage block under `model`'s rates.
 *
 * ASSUMPTION (aligned to packages/providers mapOpenAiUsage): `usage.inputTokens`
 * is the FULL input count and INCLUDES `usage.cachedInputTokens`. So we price the
 * non-cached remainder at the full input rate and the cached subset at the
 * discounted cached rate -- the cached tokens are never double-counted.
 */
export function costOf(usage: Usage, model: string): number {
  const p = pricingFor(model);
  const nonCachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (nonCachedInput / 1e6) * p.input +
    (usage.cachedInputTokens / 1e6) * p.cachedInput +
    (usage.outputTokens / 1e6) * p.output +
    (usage.sttSeconds / 60) * p.sttPerMin
  );
}

/** One appended ledger line. `timestamp` is injected (never Date.now here). */
export interface LedgerSummary {
  timestamp: string;
  model: string;
  cases: number;
  totalUsd: number;
  avgUsdPerCase: number;
  [key: string]: unknown;
}

/**
 * Accumulates spend across a run and enforces a hard cap. `add` prices a call and
 * commits it, throwing BEFORE committing if it would breach the cap. `assertWithin`
 * lets a caller check a projected (not-yet-made) call up front, so a run can abort
 * cleanly before ever hitting the network.
 */
export class CostAccountant {
  private accumulated = 0;
  private calls = 0;

  constructor(private readonly capUsd: number) {
    if (!(capUsd > 0)) {
      throw new Error(`CostAccountant cap must be a positive USD amount, got ${capUsd}`);
    }
  }

  /** Cumulative USD committed so far. */
  total(): number {
    return this.accumulated;
  }

  /** Number of calls committed via `add`. */
  count(): number {
    return this.calls;
  }

  /** USD headroom left under the cap. */
  remaining(): number {
    return this.capUsd - this.accumulated;
  }

  /**
   * Throw if committing `projectedUsd` on top of what's accumulated would exceed
   * the cap. Purely a check -- commits nothing. Use conservatively before a call.
   */
  assertWithin(projectedUsd: number): void {
    if (this.accumulated + projectedUsd > this.capUsd) {
      throw new Error(
        `Budget cap $${this.capUsd.toFixed(4)} would be exceeded: ` +
          `$${this.accumulated.toFixed(6)} accumulated + $${projectedUsd.toFixed(6)} projected ` +
          `= $${(this.accumulated + projectedUsd).toFixed(6)}. Aborting before the call.`,
      );
    }
  }

  /**
   * Price `usage` under `model`, enforce the cap, then commit it. Returns the
   * incremental USD for this call. Throws BEFORE committing if it would exceed the
   * cap (so cumulative spend can never cross the boundary).
   */
  add(usage: Usage, model: string): number {
    const cost = costOf(usage, model);
    this.assertWithin(cost);
    this.accumulated += cost;
    this.calls += 1;
    return cost;
  }

  /** Append one JSON line describing this run to `path`. `summary` carries its own timestamp. */
  appendLedger(path: string, summary: LedgerSummary): void {
    appendFileSync(path, `${JSON.stringify(summary)}\n`);
  }
}

/**
 * Absolute path to the repo-root `test-costs.jsonl` ledger (gitignored). Resolved
 * from this file's location: apps/server/src/eval/cost.ts -> up four -> repo root.
 */
export function defaultLedgerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../..", "test-costs.jsonl");
}
