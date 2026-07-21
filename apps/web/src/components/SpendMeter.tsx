import { useAppStore } from "../store/context";
import { formatTokens, formatUsd, totalCost, totalTokens } from "../store/pricing";

// The small gray per-document total at the bottom of the chat sidebar: the sum
// of every turn's usage as tokens + estimated USD. Computed, not tracked.

export function SpendMeter() {
  const usages = useAppStore((s) => s.usages);
  const tokens = totalTokens(usages);
  const cost = totalCost(usages);
  return (
    <div className="qa-spend-meter px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500 tabular-nums">
      <span className="qa-spend-tokens">{formatTokens(tokens)} tokens</span>
      <span className="mx-1">·</span>
      <span className="qa-spend-usd">{formatUsd(cost)}</span>
    </div>
  );
}
