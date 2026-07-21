import { describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import type { ChatEntry } from "@yammer/shared";
import { ChatSidebar } from "./ChatSidebar";
import { renderWithStore } from "../test/render";

const chat: ChatEntry[] = [
  { kind: "user_message", id: "1", at: "t", text: "write a haiku" },
  { kind: "ai_message", id: "2", at: "t", text: "Here is a start." },
  { kind: "edit", id: "3", at: "t", author: "ai", summary: "Inserted a line", versionId: "v1" },
  { kind: "error", id: "4", at: "t", message: "Version not found" },
];

describe("ChatSidebar", () => {
  it("renders each chat entry with its attributed content", () => {
    const { container } = renderWithStore(<ChatSidebar />, { initial: { chat } });

    expect(container.querySelector(".qa-chat-user")?.textContent).toBe("write a haiku");
    expect(container.querySelector(".qa-chat-ai")?.textContent).toBe("Here is a start.");

    const edit = container.querySelector(".qa-chat-edit");
    expect(edit?.getAttribute("data-author")).toBe("ai");
    expect(edit?.textContent).toContain("Inserted a line");

    expect(container.querySelector(".qa-chat-error")?.textContent).toBe("Version not found");
  });

  it("shows the spend meter total for the recorded turn usages", () => {
    const { container, store } = renderWithStore(<ChatSidebar />, { initial: { chat: [] } });

    act(() => {
      store.setState({
        usages: [
          { sttSeconds: 0, inputTokens: 1000, cachedInputTokens: 900, outputTokens: 100 },
        ],
      });
    });

    // 1000 input + 100 output tokens.
    expect(container.querySelector(".qa-spend-tokens")?.textContent).toBe("1,100 tokens");
    // 100*$1/1M + 900*$0.10/1M + 100*$6/1M = $0.00079.
    expect(container.querySelector(".qa-spend-usd")?.textContent).toBe("$0.0008");
  });

  it("folds a research turn's usage into the spend meter alongside LLM turns", async () => {
    const { container, store } = renderWithStore(<ChatSidebar />, {
      initial: {
        activeDocument: { id: "d1", name: "Doc", text: "x", currentVersionId: "v0", currentSeq: 0 },
        history: [],
        undoStack: [],
        undoCursor: -1,
      },
      api: {
        researchSummary: "Findings.",
        researchUsage: { sttSeconds: 0, inputTokens: 300, cachedInputTokens: 0, outputTokens: 40 },
      },
    });

    // Seed a prior LLM-turn usage, then run a research turn.
    act(() => {
      store.setState({
        usages: [{ sttSeconds: 0, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 }],
      });
    });
    await act(async () => {
      store.getState().dispatch({ type: "research", queries: ["q"] });
      await new Promise((r) => setTimeout(r, 0));
    });

    // 100+10 (turn) + 300+40 (research) = 450 tokens summed into the meter.
    expect(container.querySelector(".qa-spend-tokens")?.textContent).toBe("450 tokens");
    // And the digested note is rendered as a research entry.
    expect(container.querySelector(".qa-chat-research")?.textContent).toContain("Findings.");
  });
});
