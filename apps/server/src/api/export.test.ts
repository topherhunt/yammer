import { describe, it, expect } from "vitest";
import { exportDocument } from "./export";

describe("exportDocument", () => {
  it("returns raw markdown verbatim with a sanitized .md filename", async () => {
    const file = await exportDocument("My Notes!", "# Hi\n\nbody", "md");
    expect(file.filename).toBe("My_Notes.md");
    expect(file.contentType).toContain("text/markdown");
    expect(file.body).toBe("# Hi\n\nbody");
  });

  it("converts markdown into a non-empty .docx (zip) buffer", async () => {
    const file = await exportDocument("Report", "# Title\n\nSome **bold** text.", "docx");
    expect(file.filename).toBe("Report.docx");
    expect(file.contentType).toContain("wordprocessingml.document");
    const bytes = new Uint8Array(file.body as ArrayBuffer);
    expect(bytes.byteLength).toBeGreaterThan(0);
    // .docx is a zip archive -> begins with the PK signature.
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });
});
