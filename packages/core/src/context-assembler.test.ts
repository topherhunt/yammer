import { describe, expect, it } from "vitest";
import { assembleContext } from "./context-assembler";
import { applyAction } from "./reducer";
import { docState, makeCtx } from "./test-helpers";

describe("assembleContext", () => {
  it("numbers the document lines for reliable addressing", () => {
    const ctx = assembleContext(docState("first\nsecond"));
    expect(ctx.document?.name).toBe("My Document");
    expect(ctx.document?.lineCount).toBe(2);
    expect(ctx.document?.numberedText).toBe("1 | first\n2 | second");
  });

  it("reports no document when none is open", () => {
    const empty = assembleContext(
      docState("x", { activeDocument: null }),
    );
    expect(empty.document).toBeNull();
    expect(empty.visible).toBeNull();
  });

  it("includes open-dialog contents (the load list)", () => {
    const state = docState("x", {
      openDialog: "load",
      documents: [
        { id: "d1", name: "Letter", createdAt: "2026-01-01", updatedAt: "2026-02-01" },
      ],
    });
    const ctx = assembleContext(state);
    expect(ctx.openDialog?.kind).toBe("load");
    expect(ctx.openDialog?.contents).toContain("Letter");
  });

  it("limits recent chat to the requested window", () => {
    let state = docState("hello");
    const c = makeCtx("ai");
    // produce several edits to fill the chat log
    for (let i = 0; i < 6; i++) {
      state = applyAction(
        state,
        { type: "edit_text", edits: [{ find: "hello", replace: `hello${i}` }] },
        c,
      ).state;
      // rename target back so the next find matches
      state = applyAction(
        state,
        { type: "edit_text", edits: [{ find: `hello${i}`, replace: "hello" }] },
        c,
      ).state;
    }
    const ctx = assembleContext(state, { recentChatLimit: 3 });
    expect(ctx.recentChat).toHaveLength(3);
  });

  it("summarizes history rather than dumping every diff", () => {
    const edited = applyAction(
      docState("one"),
      { type: "edit_text", edits: [{ find: "one", replace: "two" }] },
      makeCtx("ai"),
    ).state;
    const ctx = assembleContext(edited);
    expect(ctx.historySummary).toContain("v1");
    expect(ctx.historySummary).toContain("edit");
  });
});
