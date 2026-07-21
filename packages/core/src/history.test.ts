import { describe, expect, it } from "vitest";
import { createVersion, currentVersion, findVersion } from "./history";

const NOW = "2026-07-21T00:00:00.000Z";

function create(text: string) {
  return createVersion({
    id: "v0",
    createdAt: NOW,
    documentId: "doc1",
    parent: null,
    author: "user",
    kind: "create",
    newText: text,
    summary: "Created",
  });
}

describe("createVersion", () => {
  it("makes the first version seq 0 with a null parent", () => {
    const v = create("hello");
    expect(v.seq).toBe(0);
    expect(v.parentVersionId).toBeNull();
    expect(v.fullText).toBe("hello");
  });

  it("increments seq and links the parent on a child version", () => {
    const parent = create("hello");
    const child = createVersion({
      id: "v1",
      createdAt: NOW,
      documentId: "doc1",
      parent,
      author: "ai",
      kind: "edit",
      newText: "hello world",
      summary: "Appended world",
    });
    expect(child.seq).toBe(1);
    expect(child.parentVersionId).toBe("v0");
    expect(child.diff).toContainEqual({ kind: "add", value: "hello world" });
  });

  it("records provenance for a restore version", () => {
    const parent = create("hello");
    const restore = createVersion({
      id: "v1",
      createdAt: NOW,
      documentId: "doc1",
      parent,
      author: "ai",
      kind: "restore",
      newText: "hello",
      summary: "Restored",
      restoredFromVersionId: "v0",
    });
    expect(restore.restoredFromVersionId).toBe("v0");
  });
});

describe("history lookups", () => {
  it("currentVersion returns the last appended version", () => {
    const v0 = create("a");
    const v1 = createVersion({
      id: "v1",
      createdAt: NOW,
      documentId: "doc1",
      parent: v0,
      author: "ai",
      kind: "edit",
      newText: "ab",
      summary: "edit",
    });
    expect(currentVersion([v0, v1])).toBe(v1);
    expect(currentVersion([])).toBeNull();
  });

  it("findVersion locates by id", () => {
    const v0 = create("a");
    expect(findVersion([v0], "v0")).toBe(v0);
    expect(findVersion([v0], "nope")).toBeNull();
  });
});
