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

  it("sends only chat after the checkpoint verbatim and surfaces the summary", () => {
    const state = docState("hello", {
      chat: [
        { kind: "user_message", id: "m1", at: "t", text: "old one" },
        { kind: "user_message", id: "m2", at: "t", text: "old two" },
        { kind: "user_message", id: "m3", at: "t", text: "recent three" },
      ],
      chatSummary: "User asked to write in a terse style.",
      chatSummarizedCount: 2, // first two entries are folded into the summary
    });
    const ctx = assembleContext(state);
    expect(ctx.chatSummary).toContain("terse style");
    expect(ctx.recentChat).toEqual([{ role: "user", text: "recent three" }]);
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

  it("surfaces an opened (read) version's full text for patching", () => {
    const state = docState("current text", {
      readVersion: { seq: 2, text: "line a\nline b" },
    });
    const ctx = assembleContext(state);
    expect(ctx.openedVersion?.seq).toBe(2);
    expect(ctx.openedVersion?.numberedText).toContain("line a");
  });
});
