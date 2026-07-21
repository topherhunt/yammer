import { describe, expect, it } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { AppState } from "@yammer/shared";
import { App } from "./App";
import { makeTestStore } from "./test/render";

const openDoc: Partial<AppState> = {
  activeDocument: { id: "d1", name: "Doc", text: "the cat sat", currentVersionId: "v0", currentSeq: 0 },
  history: [],
  undoStack: [],
  undoCursor: -1,
  listening: "listening",
};

describe("App shell", () => {
  it("renders both panels and the seeded document text in the editor", () => {
    const { store } = makeTestStore({ initial: openDoc });
    const { container } = render(<App store={store} />);

    expect(container.querySelector(".qa-app-shell")).not.toBeNull();
    expect(container.querySelector(".qa-chat-sidebar")).not.toBeNull();
    expect(container.querySelector(".qa-document-panel")).not.toBeNull();
    expect(container.querySelector(".qa-document-name")?.textContent).toBe("Doc");
    // Store text is reflected into the CodeMirror surface.
    expect(container.querySelector(".cm-content")?.textContent).toContain("the cat sat");
  });

  it("opens the menu and navigates to help", () => {
    const { store } = makeTestStore({ initial: openDoc });
    const { container } = render(<App store={store} />);

    fireEvent.click(container.querySelector(".qa-menu-button") as HTMLButtonElement);
    expect(container.querySelector(".qa-dialog-menu")).not.toBeNull();

    fireEvent.click(container.querySelector(".qa-menu-help") as HTMLButtonElement);
    expect(container.querySelector(".qa-dialog-help")).not.toBeNull();
  });

  it("runs a dictation turn end to end: transcript -> LLM -> edit in doc and chat", async () => {
    const { store } = makeTestStore({
      initial: openDoc,
      api: {
        turnResponder: (req) => ({
          actions: [{ type: "insert_text", position: "end", text: ` ${req.transcript}` }],
          usage: { sttSeconds: 2, inputTokens: 400, cachedInputTokens: 200, outputTokens: 15 },
          raw: {},
        }),
      },
    });
    const { container } = render(<App store={store} />);

    await act(async () => {
      await store.getState().submitTranscript("on the mat");
    });

    expect(store.getState().app.activeDocument?.text).toBe("the cat sat on the mat");
    expect(container.querySelector(".qa-chat-user")?.textContent).toBe("on the mat");
    expect(container.querySelector(".qa-chat-edit")).not.toBeNull();
    // The edit is reflected into the editor surface.
    expect(container.querySelector(".cm-content")?.textContent).toContain("on the mat");
    // Spend meter reflects the turn.
    expect(container.querySelector(".qa-spend-tokens")?.textContent).toBe("415 tokens");
  });
});
