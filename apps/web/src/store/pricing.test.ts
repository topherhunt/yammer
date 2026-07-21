import { describe, expect, it } from "vitest";
import type { Usage } from "@yammer/shared";
import {
  RATES,
  formatTokens,
  formatUsd,
  totalCost,
  totalTokens,
  usageCost,
  usageTokens,
} from "./pricing";

const usage = (partial: Partial<Usage>): Usage => ({
  sttSeconds: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  ...partial,
});

describe("usageCost", () => {
  it("prices full-price input, cached input, and output separately", () => {
    // 1000 input of which 900 cached, 100 output, no STT.
    const cost = usageCost(usage({ inputTokens: 1000, cachedInputTokens: 900, outputTokens: 100 }));
    const expected =
      100 * RATES.inputPerToken + 900 * RATES.cachedInputPerToken + 100 * RATES.outputPerToken;
    expect(cost).toBeCloseTo(expected, 12);
    // Sanity on the concrete dollars: 100*$1/1M + 900*$0.10/1M + 100*$6/1M.
    expect(cost).toBeCloseTo(0.0001 + 0.00009 + 0.0006, 12);
  });

  it("charges STT audio-seconds at the whisper rate", () => {
    expect(usageCost(usage({ sttSeconds: 60 }))).toBeCloseTo(0.017, 6);
  });
});

describe("token totals", () => {
  it("counts input + output but not cached twice", () => {
    expect(usageTokens(usage({ inputTokens: 1000, cachedInputTokens: 900, outputTokens: 40 }))).toBe(
      1040,
    );
  });

  it("sums across turns", () => {
    const usages = [
      usage({ inputTokens: 100, outputTokens: 10 }),
      usage({ inputTokens: 200, outputTokens: 20 }),
    ];
    expect(totalTokens(usages)).toBe(330);
    expect(totalCost(usages)).toBeCloseTo(usageCost(usages[0]!) + usageCost(usages[1]!), 12);
  });
});

describe("formatting", () => {
  it("groups token counts with commas", () => {
    expect(formatTokens(1234567)).toBe("1,234,567");
  });

  it("shows sub-dollar totals with 4 decimals and larger ones with 2", () => {
    expect(formatUsd(0.0021)).toBe("$0.0021");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(0)).toBe("$0.00");
  });
});
