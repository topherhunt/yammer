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
      {
        markFrom: 102,
        contentFrom: 103,
        contentTo: 107,
        markTo: 108,
        classes: ["qa-md-italic"],
      },
    ]);
  });

  it("reads ** as bold, not two italics", () => {
    const spans = spansForLine("**loud**", 0);
    expect(spans).toEqual([
      { markFrom: 0, contentFrom: 2, contentTo: 6, markTo: 8, classes: ["qa-md-bold"] },
    ]);
  });

  it("matches single-char content like **b**", () => {
    const spans = spansForLine("**b**", 0);
    expect(spans).toEqual([
      { markFrom: 0, contentFrom: 2, contentTo: 3, markTo: 5, classes: ["qa-md-bold"] },
    ]);
  });

  it("finds sibling bold and italic spans without merging them", () => {
    const spans = spansForLine("**b** and *i*", 0);
    expect(spans.map((s) => s.classes)).toEqual([["qa-md-bold"], ["qa-md-italic"]]);
  });

  it("nests italic inside bold (**bold *and italic* here**)", () => {
    const spans = spansForLine("**bold *and italic* here**", 0);
    // Outer bold covers the whole inner content; the inner italic sits within it.
    expect(spans[0]).toMatchObject({ markFrom: 0, classes: ["qa-md-bold"] });
    const italic = spans.find((s) => s.classes[0] === "qa-md-italic");
    expect(italic).toBeDefined();
    expect("bold *and italic* here".slice(italic!.contentFrom - 2, italic!.contentTo - 2)).toBe(
      "and italic",
    );
  });

  it("nests bold inside italic (*italic **and bold** here*)", () => {
    const spans = spansForLine("*italic **and bold** here*", 0);
    expect(spans[0]).toMatchObject({ markFrom: 0, classes: ["qa-md-italic"] });
    expect(spans.some((s) => s.classes[0] === "qa-md-bold")).toBe(true);
  });

  it("renders ***x*** as both bold and italic", () => {
    const spans = spansForLine("***x***", 0);
    expect(spans).toEqual([
      {
        markFrom: 0,
        contentFrom: 3,
        contentTo: 4,
        markTo: 7,
        classes: ["qa-md-bold", "qa-md-italic"],
      },
    ]);
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
