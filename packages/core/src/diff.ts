import type { DiffHunk } from "@yammer/shared";

// Line-level diff via longest-common-subsequence, dependency-free. Used only for
// display (history list, chat log); correctness of restore/undo never depends on
// it -- that comes from the full-text snapshots.

// Above this line count on either side we skip the O(n*m) LCS matrix (a ~5000
// line doc would allocate ~25M cells per commit) and fall back to a linear
// prefix/suffix trim. The diff is display-only, so a coarser result is fine.
const MAX_LCS_LINES = 1500;

export function computeDiff(oldText: string, newText: string): DiffHunk[] {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];
  const m = a.length;
  const n = b.length;

  if (m > MAX_LCS_LINES || n > MAX_LCS_LINES) {
    return coarseDiff(a, b);
  }

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

/** Linear fallback for very large inputs: keep common leading/trailing lines as
 * context and mark the differing middle as one remove block + one add block. */
function coarseDiff(a: string[], b: string[]): DiffHunk[] {
  const m = a.length;
  const n = b.length;
  let start = 0;
  while (start < m && start < n && a[start] === b[start]) start++;
  let endA = m;
  let endB = n;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const hunks: DiffHunk[] = [];
  if (start > 0) hunks.push({ kind: "context", value: a.slice(0, start).join("\n") });
  if (endA > start) hunks.push({ kind: "remove", value: a.slice(start, endA).join("\n") });
  if (endB > start) hunks.push({ kind: "add", value: b.slice(start, endB).join("\n") });
  if (endA < m) hunks.push({ kind: "context", value: a.slice(endA).join("\n") });
  return hunks;
}
