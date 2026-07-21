import { describe, it, expect } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@yammer/shared";

import { CostAccountant, costOf, pricingFor } from "./cost";

// A Usage where inputTokens (1000) INCLUDES the cached subset (400), matching the
// provider mapping the cost math is aligned to.
const usage: Usage = {
  sttSeconds: 0,
  inputTokens: 1000,
  cachedInputTokens: 400,
  outputTokens: 200,
};

describe("costOf", () => {
  it("prices non-cached input, cached input, and output separately on Luna", () => {
    // non-cached input = 1000 - 400 = 600 @ $1/1M  = 0.0006
    // cached input     = 400 @ $0.10/1M            = 0.00004
    // output           = 200 @ $6/1M               = 0.0012
    const expected = (600 / 1e6) * 1 + (400 / 1e6) * 0.1 + (200 / 1e6) * 6;
    expect(costOf(usage, "gpt-5.6-luna")).toBeCloseTo(expected, 12);
    expect(costOf(usage, "gpt-5.6-luna")).toBeCloseTo(0.00184, 12);
  });

  it("prices Terra higher than Luna for the same usage", () => {
    // non-cached 600 @ $2.50/1M + cached 400 @ $0.25/1M + output 200 @ $15/1M
    const expected = (600 / 1e6) * 2.5 + (400 / 1e6) * 0.25 + (200 / 1e6) * 15;
    expect(costOf(usage, "gpt-5.6-terra")).toBeCloseTo(expected, 12);
    expect(costOf(usage, "gpt-5.6-terra")).toBeGreaterThan(costOf(usage, "gpt-5.6-luna"));
  });

  it("bills STT per audio minute", () => {
    const sttUsage: Usage = { sttSeconds: 30, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    // 30s = 0.5 min @ $0.017/min = 0.0085
    expect(costOf(sttUsage, "gpt-5.6-luna")).toBeCloseTo((30 / 60) * 0.017, 12);
  });

  it("falls back to the documented default pricing for an unknown model id", () => {
    expect(costOf(usage, "totally-made-up")).toBe(costOf(usage, "gpt-5.6-luna"));
    expect(pricingFor("totally-made-up")).toEqual(pricingFor("gpt-5.6-luna"));
  });
});

describe("CostAccountant", () => {
  it("accumulates incremental cost and counts committed calls", () => {
    const acc = new CostAccountant(1);
    const first = acc.add(usage, "gpt-5.6-luna");
    const second = acc.add(usage, "gpt-5.6-luna");
    expect(first).toBeCloseTo(0.00184, 12);
    expect(second).toBeCloseTo(0.00184, 12);
    expect(acc.count()).toBe(2);
    expect(acc.total()).toBeCloseTo(0.00368, 12);
    expect(acc.remaining()).toBeCloseTo(1 - 0.00368, 12);
  });

  it("throws at the cap boundary BEFORE committing the over-budget call", () => {
    const oneCall = costOf(usage, "gpt-5.6-luna");
    // Cap sits a hair under two calls: the first commits, the second must throw.
    const acc = new CostAccountant(oneCall * 1.5);
    expect(acc.add(usage, "gpt-5.6-luna")).toBeCloseTo(oneCall, 12);
    expect(() => acc.add(usage, "gpt-5.6-luna")).toThrow(/Budget cap .* would be exceeded/);
    // The rejected call left total and count untouched.
    expect(acc.count()).toBe(1);
    expect(acc.total()).toBeCloseTo(oneCall, 12);
  });

  it("assertWithin throws for a projected call that would breach the cap", () => {
    const acc = new CostAccountant(0.001);
    expect(() => acc.assertWithin(0.002)).toThrow(/Aborting before the call/);
    expect(() => acc.assertWithin(0.0005)).not.toThrow();
    // A pure projection commits nothing.
    expect(acc.count()).toBe(0);
    expect(acc.total()).toBe(0);
  });

  it("rejects a non-positive cap", () => {
    expect(() => new CostAccountant(0)).toThrow(/positive USD amount/);
  });

  it("appends one parseable JSON ledger line carrying the injected timestamp", () => {
    const path = join(tmpdir(), `yammer-cost-ledger-${process.pid}-${Math.random()}.jsonl`);
    try {
      const acc = new CostAccountant(1);
      acc.add(usage, "gpt-5.6-luna");
      const summary = {
        timestamp: "2026-07-21T00:00:00.000Z",
        model: "gpt-5.6-luna",
        cases: 1,
        totalUsd: acc.total(),
        avgUsdPerCase: acc.total(),
      };
      acc.appendLedger(path, summary);
      acc.appendLedger(path, { ...summary, cases: 2 });

      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.timestamp).toBe("2026-07-21T00:00:00.000Z");
      expect(parsed.model).toBe("gpt-5.6-luna");
      expect(parsed.cases).toBe(1);
      expect(parsed.totalUsd).toBeCloseTo(0.00184, 12);
    } finally {
      rmSync(path, { force: true });
    }
  });
});
