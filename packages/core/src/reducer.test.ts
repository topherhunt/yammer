import type { ChatEntry, Effect } from "@yammer/shared";
import { initialState } from "@yammer/shared";
import { describe, expect, it } from "vitest";
import { applyAction, applyActions, applyTurn } from "./reducer";
import { docState, makeCtx } from "./test-helpers";

function effectTypes(effects: Effect[]): string[] {
  return effects.map((e) => e.type);
}

function lastChat(chat: ChatEntry[]): ChatEntry {
  return chat[chat.length - 1]!;
}

describe("edit_text", () => {
  it("applies the edit, appends a version, and updates the active document", () => {
    const { state, effects } = applyAction(
      docState("the cat sat"),
      { type: "edit_text", edits: [{ find: "cat", replace: "dog" }] },
      makeCtx("ai"),
    );

    expect(state.activeDocument?.text).toBe("the dog sat");
    expect(state.history).toHaveLength(2);
    expect(state.history[1]?.fullText).toBe("the dog sat");
    expect(state.activeDocument?.currentSeq).toBe(1);
    expect(effectTypes(effects)).toEqual(["persist_version"]);
  });

  it("logs the edit in the chat, attributed to the acting author", () => {
    const { state } = applyAction(
      docState("hi"),
      { type: "edit_text", edits: [{ find: "hi", replace: "hey" }] },
      makeCtx("user"),
    );
    const entry = lastChat(state.chat);
    expect(entry.kind).toBe("edit");
    if (entry.kind === "edit") {
      expect(entry.author).toBe("user");
      expect(entry.summary).toContain("Replaced");
    }
  });

  it("surfaces a chat error and does not mutate the document on a missing anchor", () => {
    const before = docState("hello");
    const { state, effects } = applyAction(
      before,
      { type: "edit_text", edits: [{ find: "zzz", replace: "!" }] },
      makeCtx("ai"),
    );

    expect(state.activeDocument?.text).toBe("hello");
    expect(state.history).toHaveLength(1);
    expect(lastChat(state.chat).kind).toBe("error");
    expect(effectTypes(effects)).toContain("play_sfx");
    expect(effectTypes(effects)).not.toContain("persist_version");
  });

  it("errors when there is no open document", () => {
    const { state } = applyAction(
      initialState(),
      { type: "edit_text", edits: [{ find: "a", replace: "b" }] },
      makeCtx("ai"),
    );
    expect(lastChat(state.chat).kind).toBe("error");
  });
});

describe("restore_version", () => {
  it("restores prior text as a new appended version with provenance", () => {
    // v0 = "one", then edit to "one two"
    const edited = applyAction(
      docState("one"),
      { type: "edit_text", edits: [{ find: "one", replace: "one two" }] },
      makeCtx("ai"),
    ).state;
    expect(edited.activeDocument?.text).toBe("one two");

    const { state, effects } = applyAction(
      edited,
      { type: "restore_version", versionId: "v0" },
      makeCtx("ai"),
    );

    expect(state.activeDocument?.text).toBe("one");
    expect(state.history).toHaveLength(3); // append-only: nothing removed
    const restored = state.history[2]!;
    expect(restored.kind).toBe("restore");
    expect(restored.restoredFromVersionId).toBe("v0");
    expect(lastChat(state.chat).kind).toBe("restore");
    expect(effectTypes(effects)).toEqual(["persist_version"]);
  });

  it("errors on an unknown version id", () => {
    const { state } = applyAction(
      docState("x"),
      { type: "restore_version", versionId: "ghost" },
      makeCtx("ai"),
    );
    expect(lastChat(state.chat).kind).toBe("error");
  });
});

describe("restore_fragment", () => {
  it("swaps a fragment in the current text and tags the source version", () => {
    const { state } = applyAction(
      docState("keep this line"),
      {
        type: "restore_fragment",
        versionId: "v0",
        find: "this",
        replace: "that",
      },
      makeCtx("ai"),
    );
    expect(state.activeDocument?.text).toBe("keep that line");
    expect(state.history[1]?.restoredFromVersionId).toBe("v0");
  });
});

describe("set_listening", () => {
  it("moves to listening and plays the unmute sound", () => {
    const { state, effects } = applyAction(
      docState("x", { listening: "paused" }),
      { type: "set_listening", state: "listening" },
      makeCtx("ai"),
    );
    expect(state.listening).toBe("listening");
    expect(effects).toContainEqual({ type: "set_listening", state: "listening" });
    expect(effects).toContainEqual({ type: "play_sfx", sound: "unmute" });
  });

  it("plays the mute sound when pausing", () => {
    const { effects } = applyAction(
      docState("x"),
      { type: "set_listening", state: "paused" },
      makeCtx("ai"),
    );
    expect(effects).toContainEqual({ type: "play_sfx", sound: "mute" });
  });
});

describe("open_dialog", () => {
  it("opens the load dialog and persists a changed sort", () => {
    const { state, effects } = applyAction(
      docState("x"), // default loadDocSort is "updated"
      { type: "open_dialog", dialog: "load", sort: "name" },
      makeCtx("ai"),
    );
    expect(state.openDialog).toBe("load");
    expect(state.settings.loadDocSort).toBe("name");
    expect(effectTypes(effects)).toEqual(["load_documents", "persist_settings"]);
  });

  it("does not persist settings when the load sort is unchanged", () => {
    const { effects } = applyAction(
      docState("x"),
      { type: "open_dialog", dialog: "load" },
      makeCtx("ai"),
    );
    expect(effectTypes(effects)).toEqual(["load_documents"]);
  });

  it("opens the history dialog with no side effects", () => {
    const { state, effects } = applyAction(
      docState("x"),
      { type: "open_dialog", dialog: "history" },
      makeCtx("ai"),
    );
    expect(state.openDialog).toBe("history");
    expect(effects).toHaveLength(0);
  });
});

// Finding #1, pinned: multi-action turns are BEST-EFFORT, not atomic. A failed
// action never cancels unrelated actions in the same turn, and failures are
// reported via ReduceResult.error.
describe("applyActions (best-effort turns)", () => {
  it("applies independent actions even when one fails, and reports the error", () => {
    const { state, effects, error } = applyActions(
      docState("the cat sat"),
      [
        { type: "edit_text", edits: [{ find: "cat", replace: "dog" }] }, // ok
        { type: "edit_text", edits: [{ find: "zzz", replace: "!" }] }, // fails
        { type: "scroll", target: "document", direction: "down", amount: "page" }, // ok
      ],
      makeCtx("ai"),
    );

    expect(state.activeDocument?.text).toBe("the dog sat"); // first edit applied
    expect(error).toMatch(/not found/); // failure surfaced explicitly
    expect(effectTypes(effects)).toContain("persist_version"); // from the ok edit
    expect(effectTypes(effects)).toContain("scroll_to"); // later ok action still ran
  });

  it("never discards dictated text because a later unrelated edit fails", () => {
    const { state, error } = applyActions(
      docState("hello"),
      [
        { type: "insert_text", position: "end", text: " world" }, // dictation, ok
        { type: "edit_text", edits: [{ find: "zzz", replace: "!" }] }, // unrelated fail
      ],
      makeCtx("ai"),
    );
    expect(state.activeDocument?.text).toBe("hello world"); // dictation survives
    expect(error).toBeDefined();
  });

  it("reports no error when every action applies", () => {
    const { error } = applyActions(
      docState("hi"),
      [
        { type: "edit_text", edits: [{ find: "hi", replace: "hey" }] },
        { type: "close_dialog" },
      ],
      makeCtx("ai"),
    );
    expect(error).toBeUndefined();
  });
});

describe("scroll", () => {
  it("resolves an 'active' target to the focused panel", () => {
    const { effects } = applyAction(
      docState("x", { activePanel: "chat" }),
      { type: "scroll", target: "active", direction: "down", amount: "page" },
      makeCtx("ai"),
    );
    expect(effects).toEqual([
      { type: "scroll_to", target: "chat", direction: "down", amount: "page" },
    ]);
  });
});

describe("clarify and research", () => {
  it("clarify posts the question as an assistant message with no effects", () => {
    const { state, effects } = applyAction(
      docState("x"),
      { type: "clarify", question: "Which paragraph do you mean?" },
      makeCtx("ai"),
    );
    const entry = lastChat(state.chat);
    expect(entry.kind).toBe("ai_message");
    expect(effects).toHaveLength(0);
  });

  it("research posts a thinking status and requests the research effect", () => {
    const { state, effects } = applyAction(
      docState("x"),
      { type: "research", queries: ["als speech devices"] },
      makeCtx("ai"),
    );
    expect(lastChat(state.chat).kind).toBe("thinking");
    expect(effects).toEqual([
      { type: "run_research", queries: ["als speech devices"] },
    ]);
  });
});

describe("copy_document", () => {
  it("requests the full document text be copied to the clipboard", () => {
    const { effects } = applyAction(
      docState("line one\nline two"),
      { type: "copy_document" },
      makeCtx("ai"),
    );
    expect(effects).toEqual([
      { type: "copy_to_clipboard", text: "line one\nline two" },
    ]);
  });

  it("errors when no document is open", () => {
    const { state } = applyAction(
      initialState(),
      { type: "copy_document" },
      makeCtx("ai"),
    );
    expect(lastChat(state.chat).kind).toBe("error");
  });
});

describe("applyTurn", () => {
  it("adds the chat message before applying actions, and history only grows", () => {
    const start = docState("hello");
    const { state } = applyTurn(
      start,
      {
        chatMessage: "Done.",
        actions: [{ type: "edit_text", edits: [{ find: "hello", replace: "hi" }] }],
      },
      makeCtx("ai"),
    );

    const aiMsg = state.chat.find((c) => c.kind === "ai_message");
    expect(aiMsg && aiMsg.kind === "ai_message" ? aiMsg.text : "").toBe("Done.");
    expect(state.activeDocument?.text).toBe("hi");
    // append-only invariant: the original create version is still first
    expect(state.history[0]?.id).toBe("v0");
    expect(state.history.length).toBeGreaterThan(start.history.length);
  });
});
