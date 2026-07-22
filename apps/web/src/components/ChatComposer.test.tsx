import { describe, expect, it } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { AppState } from "@yammer/shared";
import { ChatComposer } from "./ChatComposer";
import { makeTestStore } from "../test/render";
import { StoreProvider } from "../store/context";

// The composer: type-or-speak input at the bottom of the chat. STT streams into it
// as gray preview text; Enter (or end-of-speech) submits it as a message.

const withDoc: Partial<AppState> = {
  activeDocument: { id: "d1", name: "Doc", text: "hi", currentVersionId: "v0", currentSeq: 0 },
  history: [],
  undoStack: [],
  undoCursor: -1,
  listening: "listening",
};

function renderComposer(initial: Partial<AppState> = withDoc) {
  const { store } = makeTestStore({ initial });
  const utils = render(
    <StoreProvider store={store}>
      <ChatComposer />
    </StoreProvider>,
  );
  const box = utils.container.querySelector(".qa-composer-input") as HTMLTextAreaElement;
  return { store, box, ...utils };
}

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("ChatComposer", () => {
  it("previews the live STT transcript as gray, read-only text until submitted", () => {
    const { store, box } = renderComposer();
    act(() => store.getState().setInterim("adding a new paragraph"));
    expect(box.value).toBe("adding a new paragraph");
    expect(box.readOnly).toBe(true);
    expect(box.className).toContain("qa-composer-interim");
  });

  it("submits a typed message on Enter as a user bubble and clears the box", async () => {
    const { store, box } = renderComposer();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "write a haiku" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await tick(); // the turn loop adds the user_message asynchronously

    const chat = store.getState().app.chat;
    expect(chat.some((e) => e.kind === "user_message" && e.text === "write a haiku")).toBe(true);
    expect(box.value).toBe("");
  });

  it("does not submit an empty/whitespace draft on Enter", async () => {
    const { store, box } = renderComposer();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.keyDown(box, { key: "Enter" });
    await tick();
    expect(store.getState().app.chat.some((e) => e.kind === "user_message")).toBe(false);
  });

  it("clears the interim preview once the utterance is submitted as a message", async () => {
    const { store } = renderComposer();
    act(() => store.getState().setInterim("half a sentence"));
    expect(store.getState().interimTranscript).toBe("half a sentence");

    await act(async () => {
      await store.getState().submitTranscript("half a sentence");
    });
    expect(store.getState().interimTranscript).toBe("");
  });
});
