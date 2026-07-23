// @vitest-environment jsdom
// toggleWrap builds a real EditorView, which needs a DOM.
import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownInline, spansForLine, toggleWrap } from "./markdown-extension";

describe("spansForLine", () => {
  it("finds an italic span and reports offset-adjusted positions", () => {
    // "a *word* b" -- markers at 2 and 7, content "word" at 3..7.
    const spans = spansForLine("a *word* b", 100);
    expect(spans).toEqual([
      { markFrom: 102, contentFrom: 103, contentTo: 107, markTo: 108, cls: "qa-md-italic" },
    ]);
  });

  it("reads ** as bold, not two italics", () => {
    const spans = spansForLine("**loud**", 0);
    expect(spans).toEqual([
      { markFrom: 0, contentFrom: 2, contentTo: 6, markTo: 8, cls: "qa-md-bold" },
    ]);
  });

  it("finds both a bold and an italic span on one line", () => {
    const spans = spansForLine("**b** and *i*", 0);
    expect(spans.map((s) => s.cls)).toEqual(["qa-md-bold", "qa-md-italic"]);
  });

  it("ignores a lone asterisk and space-padded markers", () => {
    expect(spansForLine("2 * 3 = 6", 0)).toEqual([]);
    expect(spansForLine("a * b", 0)).toEqual([]);
  });
});

function makeView(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [markdownInline()] }),
  });
}

describe("toggleWrap", () => {
  it("wraps the selection with the marker", () => {
    const view = makeView("make bold please");
    view.dispatch({ selection: EditorSelection.single(5, 9) }); // "bold"
    toggleWrap(view, "**");
    expect(view.state.doc.toString()).toBe("make **bold** please");
    view.destroy();
  });

  it("unwraps when the selection is already wrapped", () => {
    const view = makeView("make **bold** please");
    view.dispatch({ selection: EditorSelection.single(7, 11) }); // "bold" inside **..**
    toggleWrap(view, "**");
    expect(view.state.doc.toString()).toBe("make bold please");
    view.destroy();
  });

  it("inserts empty markers and parks the cursor between them", () => {
    const view = makeView("x");
    view.dispatch({ selection: EditorSelection.single(1) });
    toggleWrap(view, "*");
    expect(view.state.doc.toString()).toBe("x**");
    // Cursor sits between the two asterisks (offset 2), ready to type.
    expect(view.state.selection.main.head).toBe(2);
    view.destroy();
  });
});
