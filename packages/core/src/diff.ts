import type { DiffHunk } from "@yammer/shared";

// Line-level diff via longest-common-subsequence, dependency-free. Used only for
// display (history list, chat log); correctness of restore/undo never depends on
// it -- that comes from the full-text snapshots.

export function computeDiff(oldText: string, newText: string): DiffHunk[] {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];
  const m = a.length;
  const n = b.length;

  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const hunks: DiffHunk[] = [];
  const push = (kind: DiffHunk["kind"], line: string): void => {
    const last = hunks[hunks.length - 1];
    if (last && last.kind === kind) last.value += "\n" + line;
    else hunks.push({ kind, value: line });
  };

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push("context", a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push("remove", a[i]!);
      i++;
    } else {
      push("add", b[j]!);
      j++;
    }
  }
  while (i < m) push("remove", a[i++]!);
  while (j < n) push("add", b[j++]!);

  return hunks;
}
