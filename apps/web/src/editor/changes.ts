// Minimal single-range diff between two texts, used to turn a full-text update
// from the reducer into a precise CodeMirror change (and thus a precise
// highlight range) instead of replacing the whole document. Pure and tested.

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * Trim the common prefix and suffix, returning the single minimal replacement
 * that turns `oldText` into `newText`. Returns null when the texts are equal.
 * The inserted range in the NEW document is [from, from + insert.length).
 */
export function computeChange(oldText: string, newText: string): TextChange | null {
  if (oldText === newText) return null;

  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (start < minLen && oldText[start] === newText[start]) start++;

  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--;
    endNew--;
  }

  return { from: start, to: endOld, insert: newText.slice(start, endNew) };
}
