import { EditorSelection, Prec, RangeSetBuilder } from "@codemirror/state";
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
// as bold, with the marker asterisks hidden UNLESS the cursor is inside that span (so
// the raw markers are always editable). Cmd/Ctrl+I and Cmd/Ctrl+B toggle wrapping.
//
// We deliberately hand-roll this (a small per-line regex pass) rather than pull in
// @codemirror/lang-markdown: we only want bold/italic inline, live-rendered, and a
// full markdown grammar would style-but-not-hide the markers.

type Span = {
  markFrom: number; // start of opening marker
  contentFrom: number; // first content char
  contentTo: number; // one past last content char
  markTo: number; // one past closing marker
  cls: string; // style class for the content
};

// Bold (`**...**`) is tried before italic (`*...*`) so `**x**` isn't mis-read as two
// italics. The `(?=\S)` + trailing `\S` guards require non-space at the inner edges, so
// `* ` and a lone `*` don't match; `[^*]*?` (zero or more) lets single-char content like
// `**b**` match, while excluding `*` so a span can't swallow a marker.
const INLINE = /(\*\*)(?=\S)([^*]*?\S)\*\*|(\*)(?=\S)([^*]*?\S)\*/g;

export function spansForLine(text: string, lineStart: number): Span[] {
  const spans: Span[] = [];
  INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE.exec(text))) {
    const bold = m[1] !== undefined;
    const markFrom = lineStart + m.index;
    const markLen = bold ? 2 : 1;
    const content = bold ? m[2]! : m[4]!;
    const contentFrom = markFrom + markLen;
    const contentTo = contentFrom + content.length;
    spans.push({
      markFrom,
      contentFrom,
      contentTo,
      markTo: contentTo + markLen,
      cls: bold ? "qa-md-bold" : "qa-md-italic",
    });
  }
  return spans;
}

const hideMark = Decoration.replace({});

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = view.state.selection;
  // Reveal (don't hide) the markers of a span the cursor/selection touches, so the raw
  // source is editable the moment you move into it.
  const touched = (from: number, to: number) =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      for (const s of spansForLine(line.text, line.from)) {
        const reveal = touched(s.markFrom, s.markTo);
        // Emit in strict document order: open marker, styled content, close marker.
        if (!reveal) builder.add(s.markFrom, s.contentFrom, hideMark);
        builder.add(
          s.contentFrom,
          s.contentTo,
          Decoration.mark({ class: s.cls }),
        );
        if (!reveal) builder.add(s.contentTo, s.markTo, hideMark);
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
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
  {
    decorations: (v) => v.decorations,
    // Hidden markers are atomic, so arrow keys step over them cleanly when not editing.
    provide: (plugin) =>
      EditorView.atomicRanges.of(
        (view) => view.plugin(plugin)?.decorations ?? Decoration.none,
      ),
  },
);

// Toggle wrapping the selection (or the word/point at the cursor) with `marker`. If the
// selection is already immediately wrapped in that marker, unwrap it instead.
export function toggleWrap(view: EditorView, marker: string): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const doc = state.doc;
    const len = marker.length;
    const before = doc.sliceString(range.from - len, range.from);
    const after = doc.sliceString(range.to, range.to + len);
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
    // Wrap. Empty selection -> drop the markers and place the cursor between them.
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

/** Inline markdown rendering (bold/italic) + Cmd/Ctrl+B / +I toggles. */
export function markdownInline() {
  return [markdownRenderPlugin, markdownKeymap];
}
