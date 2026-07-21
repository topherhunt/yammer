import { describe, expect, it } from "vitest";
import { applyEdits, applyInsert, EditError } from "./edit-engine";

describe("applyEdits", () => {
  it("replaces a unique match", () => {
    expect(applyEdits("the cat sat", [{ find: "cat", replace: "dog" }])).toBe(
      "the dog sat",
    );
  });

  it("applies edits left to right, so later edits see earlier results", () => {
    const out = applyEdits("a b", [
      { find: "a", replace: "x" },
      { find: "x b", replace: "done" },
    ]);
    expect(out).toBe("done");
  });

  it("targets a specific occurrence when the anchor repeats", () => {
    const out = applyEdits("na na na", [
      { find: "na", replace: "NA", occurrence: 2 },
    ]);
    expect(out).toBe("na NA na");
  });

  it("throws when the anchor is not found", () => {
    expect(() => applyEdits("hello", [{ find: "xyz", replace: "!" }])).toThrow(
      EditError,
    );
  });

  it("throws on an ambiguous anchor rather than guessing", () => {
    expect(() =>
      applyEdits("na na na", [{ find: "na", replace: "NA" }]),
    ).toThrow(/appears 3 times/);
  });

  it("throws when the occurrence is out of range", () => {
    expect(() =>
      applyEdits("na na", [{ find: "na", replace: "NA", occurrence: 5 }]),
    ).toThrow(/out of range/);
  });
});

describe("applyInsert", () => {
  it("inserts at the start", () => {
    expect(applyInsert("world", "start", "hello ")).toBe("hello world");
  });

  it("inserts at the end", () => {
    expect(applyInsert("hello", "end", " world")).toBe("hello world");
  });

  it("inserts immediately after an anchor", () => {
    expect(
      applyInsert("Dear Bob,", { afterFind: "Dear " }, "dear "),
    ).toBe("Dear dear Bob,");
  });

  it("throws when the insert anchor is missing", () => {
    expect(() =>
      applyInsert("hello", { afterFind: "zzz" }, "!"),
    ).toThrow(EditError);
  });
});
