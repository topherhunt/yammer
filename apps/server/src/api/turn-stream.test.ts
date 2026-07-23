import { describe, expect, it } from "vitest";
import { partialChatMessage } from "./turn";

// The incremental parser that pulls the chatMessage value out of the model's
// partially-streamed JSON envelope, so the reply can type in live.

describe("partialChatMessage", () => {
  it("returns '' before the chatMessage value has started", () => {
    expect(partialChatMessage("")).toBe("");
    expect(partialChatMessage('{"chat')).toBe("");
    expect(partialChatMessage('{"chatMessage":')).toBe("");
    expect(partialChatMessage('{"chatMessage": ')).toBe("");
  });

  it("returns the partial message as it streams, then the whole thing", () => {
    expect(partialChatMessage('{"chatMessage":"Adding')).toBe("Adding");
    expect(partialChatMessage('{"chatMessage":"Adding a para')).toBe("Adding a para");
    expect(partialChatMessage('{"chatMessage":"Adding a paragraph."')).toBe(
      "Adding a paragraph.",
    );
    // With the actions array following, it stops at the closing quote.
    expect(
      partialChatMessage('{"chatMessage":"Done.","actions":[{"type":"scroll"}]}'),
    ).toBe("Done.");
  });

  it("decodes JSON escapes and waits on an escape split across chunks", () => {
    expect(partialChatMessage('{"chatMessage":"line one\\nline two')).toBe(
      "line one\nline two",
    );
    expect(partialChatMessage('{"chatMessage":"a quote \\"here')).toBe('a quote "here');
    // A trailing lone backslash (escape split across stream chunks) is not emitted.
    expect(partialChatMessage('{"chatMessage":"ends\\')).toBe("ends");
  });

  it("treats a null (or absent) chatMessage as empty", () => {
    expect(partialChatMessage('{"chatMessage":null,"actions":[]}')).toBe("");
    expect(partialChatMessage('{"actions":[{"type":"scroll"}]}')).toBe("");
  });
});
