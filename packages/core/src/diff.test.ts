import { describe, expect, it } from "vitest";
import { computeDiff } from "./diff";

describe("computeDiff", () => {
  it("marks identical text as all context", () => {
    const hunks = computeDiff("one\ntwo", "one\ntwo");
    expect(hunks).toEqual([{ kind: "context", value: "one\ntwo" }]);
  });

  it("marks a pure addition", () => {
    const hunks = computeDiff("one", "one\ntwo");
    expect(hunks).toEqual([
      { kind: "context", value: "one" },
      { kind: "add", value: "two" },
    ]);
  });

  it("marks a pure removal", () => {
    const hunks = computeDiff("one\ntwo", "one");
    expect(hunks).toEqual([
      { kind: "context", value: "one" },
      { kind: "remove", value: "two" },
    ]);
  });

  it("marks a changed line as a remove followed by an add", () => {
    const hunks = computeDiff("a\nb\nc", "a\nB\nc");
    expect(hunks).toEqual([
      { kind: "context", value: "a" },
      { kind: "remove", value: "b" },
      { kind: "add", value: "B" },
      { kind: "context", value: "c" },
    ]);
  });

  it("treats writing into an empty document as all additions", () => {
    expect(computeDiff("", "fresh")).toEqual([{ kind: "add", value: "fresh" }]);
  });

  it("falls back to a linear coarse diff above the LCS size cap (no OOM)", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const changed = big + "\nEXTRA";
    expect(computeDiff(big, changed)).toEqual([
      { kind: "context", value: big },
      { kind: "add", value: "EXTRA" },
    ]);
  });
});
