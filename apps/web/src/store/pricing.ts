import type { Usage } from "@yammer/shared";

// Spend-meter math. The per-document total is SUM(usage) over the document's
// turns: STT audio-seconds x rate + inference tokens x per-model rate (input,
// cached-input, and output priced separately). Pure and unit-tested.
//
// Rates reflect the dev defaults from plan.md: gpt-realtime-whisper STT at
// $0.017/min, and GPT-5.6 Luna at $1/1M input, $6/1M output, with the 90%
// cached-input discount ($0.10/1M). ASSUMPTION: cachedInputTokens is a subset
// of inputTokens (the OpenAI reporting convention), so billed full-price input
// is (inputTokens - cachedInputTokens) and cached tokens count once toward the
// token display, not twice.

export const RATES = {
  sttPerSecond: 0.017 / 60,
  inputPerToken: 1 / 1_000_000,
  cachedInputPerToken: 0.1 / 1_000_000,
  outputPerToken: 6 / 1_000_000,
} as const;

export function usageCost(u: Usage): number {
  const billedInput = Math.max(0, u.inputTokens - u.cachedInputTokens);
  return (
    u.sttSeconds * RATES.sttPerSecond +
    billedInput * RATES.inputPerToken +
    u.cachedInputTokens * RATES.cachedInputPerToken +
    u.outputTokens * RATES.outputPerToken
  );
}

/** Total inference tokens shown in the meter (cached is a subset of input, so
 * it is not double-counted). STT seconds are not tokens and are excluded. */
export function usageTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens;
}

export function totalCost(usages: Usage[]): number {
  return usages.reduce((sum, u) => sum + usageCost(u), 0);
}

export function totalTokens(usages: Usage[]): number {
  return usages.reduce((sum, u) => sum + usageTokens(u), 0);
}

export function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

export function formatUsd(dollars: number): string {
  // Small totals need more precision than cents to be meaningful.
  const decimals = dollars > 0 && dollars < 1 ? 4 : 2;
  return `$${dollars.toFixed(decimals)}`;
}
