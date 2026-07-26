import { EditorSelection, Prec } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
} from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";

// Inline markdown rendering for the document surface. The stored text is always the
// markdown SOURCE (asterisks included) -- append-only history and LLM context are
// unaffected. This only changes what's DISPLAYED: `*word*` shows as italic, `**word**`
// as bold, `***word***` as both, with the marker asterisks hidden UNLESS the cursor is
// inside that span (so the raw markers are always editable). Spans NEST: `**bold *and
// italic* here**` renders the inner italic inside the bold. Cmd/Ctrl+I and Cmd/Ctrl+B
// toggle wrapping.
//
// We hand-roll a small recursive scanner (rather than pull in @codemirror/lang-markdown)
// because we want just bold/italic, live-rendered with the markers HIDDEN, and nesting.

type Span = {
  markFrom: number; // start of opening marker run
  contentFrom: number; // first content char
  contentTo: number; // one past last content char
  markTo: number; // one past closing marker run
  classes: string[]; // style classes for the content (bold, italic, or both)
};

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

// A run of asterisks is classified by length: 1 = italic, 2 = bold, 3+ = both. The
// opening and closing runs must share a kind, so italic (`*`) never mis-pairs with a
// bold (`**`) run -- which is what lets them nest.
const kindOf = (runLen: number): number => Math.min(runLen, 3);
const markLenOf = (kind: number): number => kind;
const classesOf = (kind: number): string[] =>
  kind >= 3
    ? ["qa-md-bold", "qa-md-italic"]
    : kind === 2
      ? ["qa-md-bold"]
      : ["qa-md-italic"];

// Find the nearest closing asterisk-run of `kind` in [from, hi) whose left edge is
// non-space (a valid closer) and that leaves non-empty content. Returns its start.
function findClose(text: string, from: number, hi: number, kind: number): number {
  let i = from;
  while (i < hi) {
    if (text[i] !== "*") {
      i++;
      continue;
    }
    let j = i;
    while (j < hi && text[j] === "*") j++;
    // A closer needs a non-space char immediately before it, non-empty content
    // (i > from), and the same kind as the opener.
    if (i > from && !isSpace(text[i - 1]) && kindOf(j - i) === kind) return i;
    i = j;
  }
  return -1;
}

// Recursively collect emphasis spans in [lo, hi). Nearest-match pairing: for each
// opener, take the closest valid closer of the same kind, emit the span, then recurse
// into its content (so inner emphasis nests) and continue after the closer.
function collectSpans(text: string, lo: number, hi: number, out: Span[]): void {
  let i = lo;
  while (i < hi) {
    if (text[i] !== "*") {
      i++;
      continue;
    }
    let j = i;
    while (j < hi && text[j] === "*") j++;
    const kind = kindOf(j - i);
    // A valid opener needs a non-space char immediately after the markers.
    if (isSpace(text[j])) {
      i = j;
      continue;
    }
    const markLen = markLenOf(kind);
    const contentFrom = i + markLen;
    const closeAt = findClose(text, contentFrom, hi, kind);
    if (closeAt < 0) {
      i = j;
      continue;
    }
    out.push({
      markFrom: i,
      contentFrom,
      contentTo: closeAt,
      markTo: closeAt + markLen,
      classes: classesOf(kind),
    });
    collectSpans(text, contentFrom, closeAt, out);
    i = closeAt + markLen;
  }
}

export function spansForLine(text: string, lineStart: number): Span[] {
  const spans: Span[] = [];
  collectSpans(text, 0, text.length, spans);
  // Shift to absolute document offsets.
  return spans.map((s) => ({
    ...s,
    markFrom: s.markFrom + lineStart,
    contentFrom: s.contentFrom + lineStart,
    contentTo: s.contentTo + lineStart,
    markTo: s.markTo + lineStart,
  }));
}

const hideMark = Decoration.replace({});

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const sel = view.state.selection;
  // Reveal (don't hide) a span's markers when the cursor/selection touches its extent,
  // so the raw source is editable the moment you move into it.
  const touched = (from: number, to: number) =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      for (const s of spansForLine(line.text, line.from)) {
        const reveal = touched(s.markFrom, s.markTo);
        if (!reveal) ranges.push(hideMark.range(s.markFrom, s.contentFrom));
        for (const cls of s.classes) {
          ranges.push(Decoration.mark({ class: cls }).range(s.contentFrom, s.contentTo));
        }
        if (!reveal) ranges.push(hideMark.range(s.contentTo, s.markTo));
      }
      pos = line.to + 1;
    }
  }
  // sort=true: let CodeMirror order the interleaved (nested) ranges for us.
  return Decoration.set(ranges, true);
}

const markdownRenderPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Toggle wrapping the selection (or the point at the cursor) with `marker`. If the
// selection is already immediately wrapped in that marker, unwrap it instead.
export function toggleWrap(view: EditorView, marker: string): boolean {
  const { state } = view;
  const len = marker.length;
  const changes = state.changeByRange((range) => {
    const before = state.doc.sliceString(range.from - len, range.from);
    const after = state.doc.sliceString(range.to, range.to + len);
    if (before === marker && after === marker) {
      // Already wrapped -> strip the surrounding markers. Removing `len` chars before
      // the selection shifts it left by `len`.
      return {
        changes: [
          { from: range.from - len, to: range.from, insert: "" },
          { from: range.to, to: range.to + len, insert: "" },
        ],
        range: EditorSelection.range(range.from - len, range.to - len),
      };
    }
    // Wrap. Empty selection -> drop the markers and park the cursor between them.
    return {
      changes: [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ],
      range: EditorSelection.range(range.from + len, range.to + len),
    };
  });
  view.dispatch(
    state.update(changes, { scrollIntoView: true, userEvent: "input.format" }),
  );
  return true;
}

// High precedence so Cmd/Ctrl+B / +I win over any default binding.
const markdownKeymap = Prec.high(
  keymap.of([
    { key: "Mod-b", run: (v) => toggleWrap(v, "**") },
    { key: "Mod-i", run: (v) => toggleWrap(v, "*") },
  ]),
);

/** Inline markdown rendering (bold/italic, nested) + Cmd/Ctrl+B / +I toggles. */
export function markdownInline() {
  return [markdownRenderPlugin, markdownKeymap];
}
