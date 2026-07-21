import { describe, expect, it } from "vitest";
import { parseLlmResponse } from "./parse";

describe("parseLlmResponse", () => {
  it("accepts a well-formed envelope", () => {
    const result = parseLlmResponse({
      chatMessage: "On it.",
      actions: [{ type: "edit_text", edits: [{ find: "a", replace: "b" }] }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.actions).toHaveLength(1);
      expect(result.response.actions[0]?.type).toBe("edit_text");
    }
  });

  it("applies schema defaults (scroll target/amount)", () => {
    const result = parseLlmResponse({
      actions: [{ type: "scroll", direction: "down" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const action = result.response.actions[0]!;
      if (action.type === "scroll") {
        expect(action.target).toBe("active");
        expect(action.amount).toBe("page");
      }
    }
  });

  it("rejects an unknown action type with a clear error", () => {
    const result = parseLlmResponse({
      actions: [{ type: "delete_everything" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/type/);
  });

  it("rejects an action that is missing a required field", () => {
    const result = parseLlmResponse({
      actions: [{ type: "edit_text", edits: [{ find: "a" }] }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object payload", () => {
    expect(parseLlmResponse("nope").ok).toBe(false);
    expect(parseLlmResponse(null).ok).toBe(false);
  });
});
