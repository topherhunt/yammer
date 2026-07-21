import { describe, expect, it } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { AppState } from "@yammer/shared";
import { App } from "../App";
import { makeTestStore } from "../test/render";
import { ListeningIndicator } from "./ListeningIndicator";
import { StoreProvider } from "../store/context";

// The tap-to-start gate + the indicator's reflection of machine state.

const withDoc: Partial<AppState> = {
  activeDocument: { id: "d1", name: "Doc", text: "hi", currentVersionId: "v0", currentSeq: 0 },
  history: [],
  undoStack: [],
  undoCursor: -1,
  // listening defaults to "muted" (mic not yet granted), so the gate shows.
};

describe("tap-to-start gate", () => {
  it("shows the gate until tapped, then starts listening and dismisses it", () => {
    const { store } = makeTestStore({ initial: withDoc });
    const { container } = render(<App store={store} />);

    expect(container.querySelector(".qa-tap-gate")).not.toBeNull();

    fireEvent.click(container.querySelector(".qa-tap-gate-button") as HTMLButtonElement);

    expect(store.getState().micStarted).toBe(true);
    expect(store.getState().app.listening).toBe("listening");
    // The gate is gone once listening.
    expect(container.querySelector(".qa-tap-gate")).toBeNull();
  });

  it("is not shown when a session is already listening", () => {
    const { store } = makeTestStore({
      initial: { ...withDoc, listening: "listening" },
    });
    const { container } = render(<App store={store} />);
    expect(container.querySelector(".qa-tap-gate")).toBeNull();
  });
});

describe("ListeningIndicator reflects machine signals", () => {
  it("pulses while listening + VAD active and shows the radial while finalizing", () => {
    const { store } = makeTestStore({
      initial: { ...withDoc, listening: "listening" },
    });
    const { container } = render(
      <StoreProvider store={store}>
        <ListeningIndicator />
      </StoreProvider>,
    );

    // VAD speech -> pulse.
    act(() => store.getState().setVoiceIndicator({ vad: true, finalizing: false }));
    expect(container.querySelector(".qa-mic-pulsing")).not.toBeNull();

    // Finalizing -> radial spinner, pulse off.
    act(() => store.getState().setVoiceIndicator({ vad: false, finalizing: true }));
    expect(container.querySelector(".qa-mic-pulsing")).toBeNull();
    expect(container.querySelector(".qa-radial")).not.toBeNull();
  });
});
