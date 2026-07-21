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

export type InsertPosition = "start" | "end" | { afterFind: string };

/** Apply a sequence of find/replace edits left-to-right. Throws on any miss. */
export function applyEdits(text: string, edits: FindReplace[]): string {
  let result = text;
  for (const edit of edits) {
    result = applyOne(result, edit);
  }
  return result;
}

function allIndices(haystack: string, needle: string): number[] {
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

/** Insert text at start, end, or immediately after the first match of an anchor. */
export function applyInsert(
  text: string,
  position: InsertPosition,
  insert: string,
): string {
  if (position === "start") return insert + text;
  if (position === "end") return text + insert;

  const at = text.indexOf(position.afterFind);
  if (at === -1) {
    throw new EditError(
      `Insert anchor not found: ${JSON.stringify(position.afterFind)}`,
    );
  }
  const cut = at + position.afterFind.length;
  return text.slice(0, cut) + insert + text.slice(cut);
}
