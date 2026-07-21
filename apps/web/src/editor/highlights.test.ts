// @vitest-environment jsdom
// This suite constructs a real CodeMirror EditorView, which requires a DOM.
// The root vitest config runs in the node environment, so declare jsdom per-file
// (the web package's own config already uses jsdom, where this is a no-op).
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HIGHLIGHT_DURATION_MS, highlightOpacity } from "./highlights";
import {
  addHighlight,
  clearHighlights,
  editHighlights,
  highlightItems,
  tickHighlight,
} from "./highlight-extension";

describe("highlightOpacity", () => {
  it("is full at birth and zero once expired", () => {
    expect(highlightOpacity(0)).toBe(1);
    expect(highlightOpacity(HIGHLIGHT_DURATION_MS)).toBe(0);
    expect(highlightOpacity(HIGHLIGHT_DURATION_MS + 1000)).toBe(0);
  });

  it("fades linearly across the window", () => {
    expect(highlightOpacity(HIGHLIGHT_DURATION_MS / 2)).toBeCloseTo(0.5, 6);
    expect(highlightOpacity(HIGHLIGHT_DURATION_MS / 4)).toBeCloseTo(0.75, 6);
  });
});

function makeView(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [editHighlights()] }),
  });
}

describe("highlight state field", () => {
  it("tracks an added highlight and maps it through later edits", () => {
    const view = makeView("the cat sat");
    view.dispatch({ effects: addHighlight.of({ from: 4, to: 7, at: Date.now() }) });
    expect(highlightItems(view)).toEqual([{ from: 4, to: 7 }]);

    // Insert two chars before the highlight -- it should shift right by two.
    view.dispatch({ changes: { from: 0, insert: "> " } });
    expect(highlightItems(view)).toEqual([{ from: 6, to: 9 }]);
    view.destroy();
  });

  it("drops highlights once they age past the duration on tick", () => {
    // Anchor to the real clock: the field seeds `now` from Date.now(), so a
    // birth far in the past would be filtered on add.
    const birth = Date.now();
    const view = makeView("hello");
    view.dispatch({ effects: addHighlight.of({ from: 0, to: 3, at: birth }) });
    expect(highlightItems(view)).toHaveLength(1);

    view.dispatch({ effects: tickHighlight.of(birth + HIGHLIGHT_DURATION_MS + 1) });
    expect(highlightItems(view)).toHaveLength(0);
    view.destroy();
  });

  it("clears all highlights on document switch", () => {
    const view = makeView("hello");
    view.dispatch({ effects: addHighlight.of({ from: 0, to: 3, at: Date.now() }) });
    view.dispatch({ effects: clearHighlights.of() });
    expect(highlightItems(view)).toHaveLength(0);
    view.destroy();
  });
});
