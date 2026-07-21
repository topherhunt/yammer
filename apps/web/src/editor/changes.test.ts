import { describe, expect, it } from "vitest";
import { computeChange } from "./changes";

describe("computeChange", () => {
  it("returns null when texts are equal", () => {
    expect(computeChange("hello", "hello")).toBeNull();
  });

  it("locates a mid-string replacement precisely", () => {
    // "the cat sat" -> "the dog sat": only "cat"->"dog" changes.
    const change = computeChange("the cat sat", "the dog sat");
    expect(change).toEqual({ from: 4, to: 7, insert: "dog" });
    // The inserted range in the new doc is [from, from+insert.length).
    expect("the dog sat".slice(change!.from, change!.from + change!.insert.length)).toBe("dog");
  });

  it("handles a pure insertion at the end", () => {
    expect(computeChange("abc", "abcdef")).toEqual({ from: 3, to: 3, insert: "def" });
  });

  it("handles a pure deletion", () => {
    expect(computeChange("abcdef", "abc")).toEqual({ from: 3, to: 6, insert: "" });
  });

  it("handles insertion at the start", () => {
    expect(computeChange("world", "hello world")).toEqual({ from: 0, to: 0, insert: "hello " });
  });

  it("handles repeated characters without over-trimming", () => {
    // Common prefix "a", common suffix "" -- the change spans from index 1.
    const change = computeChange("aaa", "aXa");
    expect(change).toEqual({ from: 1, to: 2, insert: "X" });
  });
});
