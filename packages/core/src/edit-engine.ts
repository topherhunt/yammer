// Pure text-editing primitives. These fail explicitly: a find anchor that does
// not match, or matches ambiguously without an occurrence, throws rather than
// silently doing the wrong thing. The reducer catches EditError and surfaces it
// as an error in the chat log.

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

export interface FindReplace {
  find: string;
  replace: string;
  occurrence?: number; // 1-based
}

export type InsertPosition =
  | "start"
  | "end"
  | "cursor"
  | { afterFind: string; occurrence?: number };

/** Resolve an InsertPosition to a character offset. `cursor` is the current
 * insertion point (clamped to the text); the anchored form throws (missing /
 * ambiguous) exactly like applyInsert. */
export function insertOffset(
  text: string,
  position: InsertPosition,
  cursor: number,
): number {
  if (position === "start") return 0;
  if (position === "end") return text.length;
  if (position === "cursor") return Math.max(0, Math.min(cursor, text.length));

  const { afterFind, occurrence } = position;
  const indices = allIndices(text, afterFind);
  if (indices.length === 0) {
    throw new EditError(`Insert anchor not found: ${JSON.stringify(afterFind)}`);
  }
  let at: number;
  if (occurrence == null) {
    if (indices.length > 1) {
      throw new EditError(
        `Ambiguous insert anchor: ${JSON.stringify(afterFind)} appears ${indices.length} times; specify an occurrence.`,
      );
    }
    at = indices[0]!;
  } else {
    if (occurrence < 1 || occurrence > indices.length) {
      throw new EditError(
        `Occurrence ${occurrence} out of range: ${JSON.stringify(afterFind)} appears ${indices.length} time(s).`,
      );
    }
    at = indices[occurrence - 1]!;
  }
  return at + afterFind.length;
}

/** Where the cursor should sit after a text change: at the END of the changed
 * region (common-prefix + inserted content). For a pure deletion it lands where the
 * text was removed. Used to keep the insertion cursor with the latest edit. */
export function cursorAfterChange(oldText: string, newText: string): number {
  let p = 0;
  const max = Math.min(oldText.length, newText.length);
  while (p < max && oldText[p] === newText[p]) p++;
  // Common suffix length, not overlapping the common prefix.
  let s = 0;
  while (
    s < max - p &&
    oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]
  ) {
    s++;
  }
  return newText.length - s;
}

/** Apply a sequence of find/replace edits left-to-right. Throws on any miss. */
export function applyEdits(text: string, edits: FindReplace[]): string {
  let result = text;
  for (const edit of edits) {
    result = applyOne(result, edit);
  }
  return result;
}

function allIndices(haystack: string, needle: string): number[] {
  // An empty needle would match at every position and never advance -- guard it
  // even though the action schema (find.min(1)) makes it unreachable in practice.
  if (needle === "") return [];
  const out: number[] = [];
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    out.push(from);
    from = haystack.indexOf(needle, from + needle.length);
  }
  return out;
}

function applyOne(text: string, edit: FindReplace): string {
  const { find, replace, occurrence } = edit;
  const indices = allIndices(text, find);

  if (indices.length === 0) {
    throw new EditError(`Text to edit not found: ${JSON.stringify(find)}`);
  }

  let at: number;
  if (occurrence == null) {
    if (indices.length > 1) {
      throw new EditError(
        `Ambiguous edit: ${JSON.stringify(find)} appears ${indices.length} times; specify an occurrence.`,
      );
    }
    at = indices[0]!;
  } else {
    if (occurrence < 1 || occurrence > indices.length) {
      throw new EditError(
        `Occurrence ${occurrence} out of range: ${JSON.stringify(find)} appears ${indices.length} time(s).`,
      );
    }
    at = indices[occurrence - 1]!;
  }

  return text.slice(0, at) + replace + text.slice(at + find.length);
}

/** Insert text at start, end, or after an anchor. Like applyEdits, an anchor
 * that is missing -- or ambiguous (matches more than once) without an
 * `occurrence` -- throws rather than silently inserting at the first match. */
export function applyInsert(
  text: string,
  position: InsertPosition,
  insert: string,
): string {
  const at = insertOffset(text, position, 0);
  return text.slice(0, at) + insert + text.slice(at);
}
