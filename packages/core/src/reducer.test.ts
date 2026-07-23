import type { AppState, ChatEntry, Effect } from "@yammer/shared";
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

describe("commit_keyboard_edit", () => {
  it("snapshots the current (typed) text as one version, diffed from the head", () => {
    // Keyboard divergence: the live text changed without a version.
    const s = docState("hello");
    const typed: AppState = {
      ...s,
      activeDocument: { ...s.activeDocument!, text: "hello world" },
    };
    const { state, effects } = applyAction(
      typed,
      { type: "commit_keyboard_edit" },
      makeCtx("user"),
    );
    expect(state.history).toHaveLength(s.history.length + 1);
    expect(state.history.at(-1)?.fullText).toBe("hello world");
    expect(state.history.at(-1)?.author).toBe("user");
    expect(effectTypes(effects)).toEqual(["persist_version"]);
  });

  it("is a no-op when the live text already matches the head version", () => {
    const s = docState("hello"); // text == head.fullText
    const { state, effects } = applyAction(
      s,
      { type: "commit_keyboard_edit" },
      makeCtx("user"),
    );
    expect(state.history).toHaveLength(s.history.length);
    expect(effects).toEqual([]);
  });
});

describe("cursor", () => {
  it("moves the cursor to the end of the changed text after an edit", () => {
    const { state } = applyAction(
      docState("the cat sat", { cursor: 0 }),
      { type: "edit_text", edits: [{ find: "cat", replace: "hippopotamus" }] },
      makeCtx("ai"),
    );
    expect(state.activeDocument?.text).toBe("the hippopotamus sat");
    // Cursor lands right after the replacement, so dictation continues there.
    expect(state.cursor).toBe("the hippopotamus".length);
  });

  it("inserts at the cursor with position 'cursor' and advances the cursor past it", () => {
    const { state } = applyAction(
      docState("ab", { cursor: 1 }),
      { type: "insert_text", position: "cursor", text: "X" },
      makeCtx("ai"),
    );
    expect(state.activeDocument?.text).toBe("aXb");
    expect(state.cursor).toBe(2); // just after the inserted X
  });

  it("place_cursor moves the cursor after an anchor WITHOUT editing or versioning", () => {
    const before = docState("hello world", { cursor: 0 });
    const { state, effects } = applyAction(
      before,
      { type: "place_cursor", position: { afterFind: "hello" } },
      makeCtx("ai"),
    );
    expect(state.activeDocument?.text).toBe("hello world"); // unchanged
    expect(state.cursor).toBe(5); // just after "hello"
    expect(state.history).toHaveLength(before.history.length); // no new version
    expect(effects).toEqual([]);
  });
});

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
      { type: "restore_version", seq: 0 },
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

  it("errors on an unknown version seq", () => {
    const { state } = applyAction(
      docState("x"),
      { type: "restore_version", seq: 99 },
      makeCtx("ai"),
    );
    expect(lastChat(state.chat).kind).toBe("error");
  });
});

describe("restore_fragment", () => {
  it("swaps a fragment back to text from the named version and tags provenance", () => {
    const c = makeCtx("ai");
    let s = docState("keep that line"); // v0 contains "that"
    s = applyAction(s, { type: "edit_text", edits: [{ find: "that", replace: "this" }] }, c).state;
    const { state } = applyAction(
      s,
      { type: "restore_fragment", seq: 0, find: "this", replace: "that" },
      c,
    );
    expect(state.activeDocument?.text).toBe("keep that line");
    expect(state.history[state.history.length - 1]?.restoredFromVersionId).toBe("v0");
  });

  it("rejects a fragment restore whose text was never in that version", () => {
    const { state } = applyAction(
      docState("keep this line"), // v0 never contained "nonsense"
      { type: "restore_fragment", seq: 0, find: "this", replace: "nonsense" },
      makeCtx("ai"),
    );
    expect(lastChat(state.chat).kind).toBe("error");
    expect(state.activeDocument?.text).toBe("keep this line"); // unchanged
  });
});

describe("read_version", () => {
  it("loads an older version's full text into context for patching", () => {
    const c = makeCtx("ai");
    let s = docState("original");
    s = applyAction(s, { type: "insert_text", position: "end", text: " edited" }, c).state;
    const { state } = applyAction(s, { type: "read_version", seq: 0 }, c);
    expect(state.readVersion).toEqual({ seq: 0, text: "original" });
  });

  it("errors on an unknown version seq and leaves nothing read", () => {
    const { state } = applyAction(
      docState("x"),
      { type: "read_version", seq: 99 },
      makeCtx("ai"),
    );
    expect(lastChat(state.chat).kind).toBe("error");
    expect(state.readVersion).toBeNull();
  });

  it("clears the read version once an edit is committed (read is consumed)", () => {
    const c = makeCtx("ai");
    let s = docState("hello");
    s = applyAction(s, { type: "read_version", seq: 0 }, c).state;
    expect(s.readVersion).not.toBeNull();
    s = applyAction(s, { type: "insert_text", position: "end", text: "!" }, c).state;
    expect(s.readVersion).toBeNull();
  });
});

describe("update_settings", () => {
  it("merges only the provided fields and persists", () => {
    const { state, effects } = applyAction(
      docState("x"),
      { type: "update_settings", theme: "dark", sfxEnabled: false },
      makeCtx("ai"),
    );
    expect(state.settings.theme).toBe("dark");
    expect(state.settings.sfxEnabled).toBe(false);
    expect(state.settings.loadDocSort).toBe("updated"); // untouched
    expect(effects).toContainEqual({
      type: "persist_settings",
      settings: state.settings,
    });
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

describe("undo / redo (cursor walks the timeline, never cycles)", () => {
  // Build a 3-step document: "one" -> "one two" -> "one two three".
  function threeSteps() {
    const c = makeCtx("ai");
    let s = docState("one");
    s = applyAction(s, { type: "insert_text", position: "end", text: " two" }, c).state;
    s = applyAction(s, { type: "insert_text", position: "end", text: " three" }, c).state;
    return { s, c };
  }

  it("steps backward one version per undo instead of toggling two states", () => {
    let { s, c } = threeSteps();
    expect(s.activeDocument?.text).toBe("one two three");
    expect(s.undoCursor).toBe(2);

    s = applyAction(s, { type: "undo" }, c).state;
    expect(s.activeDocument?.text).toBe("one two");
    expect(s.undoCursor).toBe(1);

    s = applyAction(s, { type: "undo" }, c).state;
    expect(s.activeDocument?.text).toBe("one"); // walked back, did not cycle to "one two three"
    expect(s.undoCursor).toBe(0);
  });

  it("undo appends to the audit history without shrinking the timeline", () => {
    let { s, c } = threeSteps();
    const historyBefore = s.history.length;
    const stackBefore = [...s.undoStack];
    s = applyAction(s, { type: "undo" }, c).state;
    expect(s.history.length).toBe(historyBefore + 1); // append-only audit trail
    expect(s.undoStack).toEqual(stackBefore); // timeline unchanged; only the cursor moved
    expect(s.history[s.history.length - 1]?.kind).toBe("undo");
  });

  it("undoes several steps at once with a count", () => {
    let { s, c } = threeSteps();
    s = applyAction(s, { type: "undo", count: 2 }, c).state;
    expect(s.activeDocument?.text).toBe("one");
    expect(s.undoCursor).toBe(0);
  });

  it("redoes forward after undoing", () => {
    let { s, c } = threeSteps();
    s = applyAction(s, { type: "undo", count: 2 }, c).state; // -> "one"
    s = applyAction(s, { type: "redo" }, c).state;
    expect(s.activeDocument?.text).toBe("one two");
    s = applyAction(s, { type: "redo" }, c).state;
    expect(s.activeDocument?.text).toBe("one two three");
  });

  it("a new edit after undo drops the redo tail", () => {
    let { s, c } = threeSteps();
    s = applyAction(s, { type: "undo" }, c).state; // -> "one two", cursor 1
    s = applyAction(s, { type: "insert_text", position: "end", text: " four" }, c).state;
    expect(s.activeDocument?.text).toBe("one two four");

    const redo = applyAction(s, { type: "redo" }, c);
    expect(redo.error).toMatch(/Nothing to redo/); // "one two three" is no longer reachable
  });

  it("errors when there is nothing to undo or redo", () => {
    const c = makeCtx("ai");
    const s = docState("x"); // single create version, cursor 0
    expect(applyAction(s, { type: "undo" }, c).error).toMatch(/Nothing to undo/);
    expect(applyAction(s, { type: "redo" }, c).error).toMatch(/Nothing to redo/);
  });
});

describe("download_document", () => {
  it("requests an export effect in the chosen format", () => {
    const { effects } = applyAction(
      docState("# Title"),
      { type: "download_document", format: "docx" },
      makeCtx("ai"),
    );
    expect(effects).toEqual([
      { type: "export_document", documentId: "doc1", format: "docx" },
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
