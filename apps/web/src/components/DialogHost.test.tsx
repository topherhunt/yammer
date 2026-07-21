import { describe, expect, it } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import type { AppState } from "@yammer/shared";
import { createVersion } from "@yammer/core";
import { DialogHost } from "./DialogHost";
import { useStoreApi } from "../store/context";
import { renderWithStore } from "../test/render";

const v0 = createVersion({
  id: "v0",
  createdAt: "2026-01-01T00:00:00.000Z",
  documentId: "d1",
  parent: null,
  author: "user",
  kind: "create",
  newText: "the cat sat",
  summary: "Created document",
});
const v1 = createVersion({
  id: "v1",
  createdAt: "2026-01-01T00:01:00.000Z",
  documentId: "d1",
  parent: v0,
  author: "ai",
  kind: "edit",
  newText: "the dog sat",
  summary: 'Replaced "cat" with "dog"',
});

const withDoc: Partial<AppState> = {
  activeDocument: { id: "d1", name: "Doc", text: "the dog sat", currentVersionId: "v1", currentSeq: 1 },
  history: [v0, v1],
  undoStack: ["v0", "v1"],
  undoCursor: 1,
};

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("DialogHost history dialog", () => {
  it("lists versions newest-first and restores the clicked one", () => {
    const { container, store } = renderWithStore(<DialogHost />, {
      initial: { ...withDoc, openDialog: "history" },
    });

    const items = container.querySelectorAll(".qa-history-item");
    expect(items).toHaveLength(2);
    // Newest first: v1 then v0.
    expect(items[0]!.getAttribute("data-version-id")).toBe("v1");
    expect(items[1]!.getAttribute("data-version-id")).toBe("v0");

    const restoreV0 = items[1]!.querySelector(".qa-history-restore") as HTMLButtonElement;
    fireEvent.click(restoreV0);

    expect(store.getState().app.activeDocument?.text).toBe("the cat sat");
    expect(store.getState().app.history).toHaveLength(3);
  });
});

describe("DialogHost load dialog", () => {
  it("lists documents and loads the clicked one", async () => {
    const { container, store } = renderWithStore(<DialogHost />, {
      initial: {
        openDialog: "load",
        documents: [{ id: "d1", name: "Doc", createdAt: "2026-01-01", updatedAt: "2026-01-02" }],
      },
      api: {
        documentPayloads: {
          d1: {
            document: { id: "d1", name: "Doc", text: "loaded body", currentVersionId: "v0", currentSeq: 0 },
            history: [v0],
          },
        },
      },
    });

    const item = container.querySelector(".qa-load-item") as HTMLButtonElement;
    expect(item.querySelector(".qa-load-item-name")?.textContent).toBe("Doc");

    fireEvent.click(item);
    await flush();

    expect(store.getState().app.activeDocument?.text).toBe("loaded body");
    // Loading closes the dialog.
    expect(store.getState().app.openDialog).toBeNull();
  });
});

describe("DialogHost keyboard", () => {
  it("closes on Escape", () => {
    const { store } = renderWithStore(<DialogHost />, { initial: { openDialog: "menu" } });
    expect(store.getState().app.openDialog).toBe("menu");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(store.getState().app.openDialog).toBeNull();
  });
});

// A trigger button next to the dialog host, so we can assert focus moves INTO the
// dialog on open and is RESTORED to the trigger on close.
function TrapHarness() {
  const api = useStoreApi();
  return (
    <>
      <button
        type="button"
        className="qa-trigger"
        onClick={() => api.getState().dispatch({ type: "open_dialog", dialog: "menu" })}
      >
        Open menu
      </button>
      <DialogHost />
    </>
  );
}

describe("DialogHost accessibility", () => {
  it("moves focus into the dialog on open", () => {
    const { container } = renderWithStore(<TrapHarness />);
    const trigger = container.querySelector(".qa-trigger") as HTMLButtonElement;
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = container.querySelector(".qa-dialog-menu") as HTMLElement;
    // Focus is now inside the dialog, not left on the (inert) page behind it.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("traps Tab within the dialog (wraps last -> first and first -> last)", () => {
    const { container } = renderWithStore(<TrapHarness />);
    const trigger = container.querySelector(".qa-trigger") as HTMLButtonElement;
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = container.querySelector(".qa-dialog-menu") as HTMLElement;
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>("button"),
    );
    const first = focusables[0]!; // the close (✕) button
    const last = focusables[focusables.length - 1]!; // the last menu item

    // Tab off the last element wraps back to the first.
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    // Shift+Tab off the first element wraps to the last.
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("restores focus to the trigger when the dialog closes", () => {
    const { store, container } = renderWithStore(<TrapHarness />);
    const trigger = container.querySelector(".qa-trigger") as HTMLButtonElement;
    trigger.focus();
    fireEvent.click(trigger);
    expect(store.getState().app.openDialog).toBe("menu");
    // Focus was pulled into the dialog.
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(store.getState().app.openDialog).toBeNull();
    // ...and handed back to whatever opened it.
    expect(document.activeElement).toBe(trigger);
  });
});
