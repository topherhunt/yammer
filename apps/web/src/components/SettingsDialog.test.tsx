import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { AppState } from "@yammer/shared";
import { App } from "../App";
import { makeTestStore } from "../test/render";

// The Settings dialog is voice- AND click-reachable (open_dialog { dialog:
// "settings" }); changing a control updates the store settings, applies theme
// immediately (via useTheme in AppShell), and persists via the persist_settings
// effect. Rendered through <App> so useTheme is live.

const openDoc: Partial<AppState> = {
  activeDocument: { id: "d1", name: "Doc", text: "the cat sat", currentVersionId: "v0", currentSeq: 0 },
  history: [],
  undoStack: [],
  undoCursor: -1,
  listening: "listening", // so the tap-to-start gate does not overlay
};

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

afterEach(() => {
  // useTheme toggles the class on <html>, which persists across jsdom tests.
  document.documentElement.classList.remove("dark");
});

describe("Settings dialog reachability", () => {
  it("is opened from the menu via the settings item", () => {
    const { store } = makeTestStore({ initial: openDoc });
    const { container } = render(<App store={store} />);

    fireEvent.click(container.querySelector(".qa-menu-button") as HTMLButtonElement);
    fireEvent.click(container.querySelector(".qa-menu-settings") as HTMLButtonElement);

    expect(container.querySelector(".qa-dialog-settings")).not.toBeNull();
    expect(store.getState().app.openDialog).toBe("settings");
  });
});

describe("Settings dialog theme control", () => {
  it("changes the theme, applies it immediately, and fires persist_settings", async () => {
    const { store, api } = makeTestStore({ initial: { ...openDoc, openDialog: "settings" } });
    const { container } = render(<App store={store} />);

    // System theme (matchMedia stub reports light) starts undarkened.
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    fireEvent.click(container.querySelector(".qa-settings-theme-dark") as HTMLButtonElement);

    // Store settings updated...
    expect(store.getState().app.settings.theme).toBe("dark");
    // ...applied to the DOM immediately (useTheme)...
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    // ...and persisted via the persist_settings effect.
    await flush();
    expect(api.persistedSettings.at(-1)?.theme).toBe("dark");
  });

  it("switching to light theme removes the dark class", async () => {
    const { store, api } = makeTestStore({
      initial: { ...openDoc, openDialog: "settings" },
    });
    const { container } = render(<App store={store} />);

    fireEvent.click(container.querySelector(".qa-settings-theme-dark") as HTMLButtonElement);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    fireEvent.click(container.querySelector(".qa-settings-theme-light") as HTMLButtonElement);
    expect(store.getState().app.settings.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await flush();
    expect(api.persistedSettings.map((s) => s.theme)).toContain("light");
  });
});

describe("Settings dialog sound-effects control", () => {
  it("toggles sfxEnabled and persists it", async () => {
    const { store, api } = makeTestStore({ initial: { ...openDoc, openDialog: "settings" } });
    const { container } = render(<App store={store} />);

    const checkbox = container.querySelector(".qa-settings-sfx-input") as HTMLInputElement;
    expect(checkbox.checked).toBe(true); // default sfxEnabled

    fireEvent.click(checkbox);

    expect(store.getState().app.settings.sfxEnabled).toBe(false);
    await flush();
    expect(api.persistedSettings.at(-1)?.sfxEnabled).toBe(false);
  });

  it("edits a numeric voice-tuning field and persists it", async () => {
    const { store, api } = makeTestStore({ initial: { ...openDoc, openDialog: "settings" } });
    const { container } = render(<App store={store} />);

    const input = container.querySelector(".qa-settings-silence-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1200" } });

    expect(store.getState().app.settings.silenceThresholdMs).toBe(1200);
    await flush();
    expect(api.persistedSettings.at(-1)?.silenceThresholdMs).toBe(1200);
  });
});
