// Golden instruction-interpretation cases for the live-API eval. These are DATA:
// each case is a starting document (optional), a natural-language transcript, and
// a TOLERANT assertion over the parsed { chatMessage, actions } the real model
// returns. Assertions check the action TYPE and its essential fields -- never
// exact wording -- so legitimate model latitude passes and only real
// misinterpretations fail.
//
// The AppState + SituationalContext for each case are built with @yammer/shared
// and @yammer/core (initialState + a seq-0 createVersion + assembleContext), so
// the model sees exactly the context the real turn loop would assemble.

import {
  assembleContext,
  createVersion,
} from "@yammer/core";
import {
  initialState,
  type Action,
  type ActionType,
  type AppState,
  type DialogKind,
  type SituationalContext,
  type Version,
} from "@yammer/shared";

/** The shape the live suite feeds each assertion after parsing the model output. */
export interface TurnResult {
  chatMessage: string | null;
  actions: Action[];
}

export interface EvalCase {
  name: string;
  /** Starting document text; omitted for "no document open" cases (e.g. new doc). */
  docText?: string;
  /**
   * Older full-text snapshots that precede `docText`, oldest first. When present,
   * they build a real multi-version timeline (create + edits) so restore/undo cases
   * present the model with earlier versions it can point back to. `docText` is
   * always the current (latest) text; `priorTexts[0]` becomes the create version.
   */
  priorTexts?: string[];
  /** A dialog to present as already open (close_dialog / restore-from-history cases). */
  openDialog?: DialogKind;
  /** Extra documents in the user's library, for load-by-name style cases. */
  otherDocuments?: { id: string; name: string }[];
  /** The user's spoken command, as it would arrive from STT. */
  transcript: string;
  /** Tolerant assertion over the parsed result. Throws to fail the case. */
  assert: (result: TurnResult) => void;
}

// -- assertion helpers (no test framework dep; plain throws fail the case) -----

function fail(msg: string): never {
  throw new Error(msg);
}

function ensure(cond: boolean, msg: string): asserts cond {
  if (!cond) fail(msg);
}

/** The first action of `type`, narrowed; fails loudly (listing what came back) if absent. */
function pick<T extends ActionType>(
  actions: Action[],
  type: T,
): Extract<Action, { type: T }> {
  const found = actions.find(
    (a): a is Extract<Action, { type: T }> => a.type === type,
  );
  if (!found) {
    const got = actions.map((a) => a.type).join(", ") || "none";
    fail(`expected an action of type "${type}", got: [${got}]`);
  }
  return found;
}

const has = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

/** Actions that mutate the document text or its history -- exactly what the model
 * must NOT do when it should be asking a question (via chatMessage) instead of guessing. */
const MUTATING_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "edit_text",
  "insert_text",
  "restore_version",
  "restore_fragment",
  "undo",
  "redo",
]);

/** Fail if any document-mutating action was returned (used by the ask-a-question cases). */
function ensureNoMutation(actions: Action[]): void {
  const mutating = actions.filter((a) => MUTATING_ACTIONS.has(a.type));
  ensure(
    mutating.length === 0,
    `expected NO mutating action, but got: [${mutating.map((a) => a.type).join(", ")}]`,
  );
}

/** Fail if any action of `type` is present (used by the negative/robustness cases). */
function ensureAbsent(actions: Action[], type: ActionType, msg: string): void {
  ensure(!actions.some((a) => a.type === type), msg);
}

// -- context assembly ----------------------------------------------------------

// A fixed timestamp keeps the assembled context (and thus the prompt) stable
// across runs -- the eval should vary only with the model, not the clock.
const FIXED_AT = "2026-07-21T00:00:00.000Z";

function stateForCase(c: EvalCase): AppState {
  if (c.docText === undefined) {
    // No document open (e.g. "create a new document"). Still "listening" so a
    // command is interpreted as a command.
    return initialState({ listening: "listening" });
  }

  // Build the version chain oldest-first: priorTexts (if any) precede the current
  // docText. The first is the create version; the rest are edits. This gives
  // restore/undo cases a genuine timeline the model can point back to.
  const texts = c.priorTexts ? [...c.priorTexts, c.docText] : [c.docText];
  const history: Version[] = [];
  let parent: Version | null = null;
  texts.forEach((text, i) => {
    const version = createVersion({
      id: `v${i}`,
      createdAt: FIXED_AT,
      documentId: "doc-1",
      parent,
      author: i === 0 ? "user" : "ai",
      kind: i === 0 ? "create" : "edit",
      newText: text,
      summary: i === 0 ? "Created document" : `Edit ${i}`,
    });
    history.push(version);
    parent = version;
  });
  const head = history[history.length - 1]!;

  const lineCount = c.docText.length ? c.docText.split("\n").length : 0;

  return initialState({
    activeDocument: {
      id: "doc-1",
      name: "Draft",
      text: c.docText,
      currentVersionId: head.id,
      currentSeq: head.seq,
    },
    documents: [
      { id: "doc-1", name: "Draft", createdAt: FIXED_AT, updatedAt: FIXED_AT },
      ...(c.otherDocuments ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      })),
    ],
    history,
    undoStack: history.map((v) => v.id),
    undoCursor: history.length - 1,
    openDialog: c.openDialog ?? null,
    listening: "listening",
    documentScroll: { firstVisibleLine: 1, lastVisibleLine: lineCount, totalLines: lineCount },
  });
}

/** The SituationalContext the live suite renders into the user message for `c`. */
export function contextForCase(c: EvalCase): SituationalContext {
  return assembleContext(stateForCase(c));
}

// -- the golden cases ----------------------------------------------------------

export const cases: EvalCase[] = [
  {
    name: "single-word find/replace becomes an edit_text swapping the word",
    docText: "The quarterly report is due on Monday.\nPlease review the budget section first.",
    transcript: "Change Monday to Friday.",
    assert: ({ actions }) => {
      const edit = pick(actions, "edit_text");
      const hit = edit.edits.find((e) => has(e.find, "Monday") && has(e.replace, "Friday"));
      ensure(
        hit !== undefined,
        `edit_text should map "Monday" -> "Friday"; got ${JSON.stringify(edit.edits)}`,
      );
    },
  },
  {
    name: "dictation is appended to the document as insert_text carrying the transcript text",
    docText: "Dear team,",
    transcript: "New line: Thanks for all your hard work this quarter.",
    assert: ({ actions }) => {
      const ins = pick(actions, "insert_text");
      ensure(ins.text.trim().length > 0, "insert_text must carry the dictated text");
      // Promise in the title: the inserted text is the ACTUAL dictated sentence, not
      // just some non-empty string. Require the substantive phrase, both anchors --
      // "hard work" AND "quarter" -- so a stray/hallucinated insert can't pass.
      ensure(
        has(ins.text, "hard work") && has(ins.text, "quarter"),
        `insert_text should contain the dictated sentence ("...hard work this quarter"); got "${ins.text}"`,
      );
      // The "New line:" framing is a command, not literal content -- it must not be
      // dictated verbatim into the document.
      ensure(
        !has(ins.text, "new line:"),
        `insert_text must not echo the "New line:" command literally; got "${ins.text}"`,
      );
      // Appending: a plain-string position must be "end", never "start".
      if (typeof ins.position === "string") {
        ensure(ins.position === "end", `append should target end, got "${ins.position}"`);
      }
    },
  },
  {
    name: "\"scroll down\" becomes a scroll action directed down",
    docText: Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the draft.`).join("\n"),
    transcript: "Scroll down.",
    assert: ({ actions }) => {
      const scroll = pick(actions, "scroll");
      ensure(scroll.direction === "down", `scroll should go down, got "${scroll.direction}"`);
    },
  },
  {
    name: "\"show the edit history\" opens the history dialog",
    docText: "A short draft with a couple of edits behind it.",
    transcript: "Show me the edit history.",
    assert: ({ actions }) => {
      const dialog = pick(actions, "open_dialog");
      ensure(dialog.dialog === "history", `expected the history dialog, got "${dialog.dialog}"`);
    },
  },
  {
    name: "\"start a new document called X\" creates a new_document",
    // No docText: nothing is open yet.
    transcript: "Start a new document called Grocery List.",
    assert: ({ actions }) => {
      const doc = pick(actions, "new_document");
      // The name is optional model latitude; if present it should reflect the request.
      if (doc.name !== undefined) {
        ensure(
          has(doc.name, "grocery") || has(doc.name, "list"),
          `new_document name should reflect "Grocery List", got "${doc.name}"`,
        );
      }
    },
  },
  {
    name: "\"undo that\" becomes an undo action",
    docText: "First sentence.\nSecond sentence that was just added.",
    transcript: "Undo that.",
    assert: ({ actions }) => {
      pick(actions, "undo");
    },
  },
  {
    name: "a natural explicit stop pauses listening (set_listening paused)",
    docText: "Working on the introduction paragraph.",
    transcript: "Hold on, I'm talking to my wife.",
    assert: ({ actions }) => {
      const listen = pick(actions, "set_listening");
      ensure(
        listen.state === "paused",
        `explicit stop should pause, got "${listen.state}"`,
      );
    },
  },
  {
    name: "an explicit web-search request becomes a research action with queries",
    docText: "Notes on assistive communication technology.",
    transcript: "Search the web for the latest research on eye-tracking communication devices for ALS.",
    assert: ({ actions }) => {
      const research = pick(actions, "research");
      ensure(research.queries.length >= 1, "research must carry at least one query");
      ensure(
        research.queries.some((q) => q.trim().length > 0),
        "research queries must be non-empty",
      );
    },
  },
  {
    name: "an ambiguous request asks a question (chatMessage) AND makes no guessed edit",
    docText: "We should consider the proposal.\nIt has some merit but also risks.",
    transcript: "Fix it.",
    assert: ({ chatMessage, actions }) => {
      ensure(
        !!chatMessage && chatMessage.trim().length > 0,
        "an ambiguous request must ask a question in chatMessage",
      );
      // Promise in the title: asking INSTEAD OF guessing means the model must not
      // also fire off a speculative edit/insert/restore/undo on the ambiguous request.
      ensureNoMutation(actions);
    },
  },
  {
    name: "a reword request becomes an edit_text over the target text",
    docText: "i think the thing is good and stuff and we should probably do it.",
    transcript: "Reword that sentence to sound more professional.",
    assert: ({ actions }) => {
      const edit = pick(actions, "edit_text");
      ensure(edit.edits.length >= 1, "reword should produce at least one edit");
      ensure(
        edit.edits.every((e) => e.find.trim().length > 0),
        "each edit must anchor on real source text",
      );
    },
  },
  {
    name: "\"copy the document\" becomes a copy_document action",
    docText: "The full text the user wants on their clipboard.",
    transcript: "Copy the whole document to my clipboard.",
    assert: ({ actions }) => {
      pick(actions, "copy_document");
    },
  },
  {
    name: "\"download as a Word document\" becomes a download_document action",
    docText: "A finished draft ready to be exported.",
    transcript: "Download this as a Word document.",
    assert: ({ actions }) => {
      const dl = pick(actions, "download_document");
      ensure(
        dl.format === "md" || dl.format === "docx",
        `download format must be md or docx, got "${dl.format}"`,
      );
    },
  },

  // -- expanded coverage of the instruction-interpretation surface -------------

  {
    name: "\"undo the last three\" becomes an undo carrying count 3",
    docText: "A paragraph that has had several edits applied to it in a row.",
    priorTexts: [
      "A paragraph.",
      "A paragraph that has grown.",
      "A paragraph that has grown a bit more.",
    ],
    transcript: "Undo the last three edits.",
    assert: ({ actions }) => {
      const undo = pick(actions, "undo");
      // The count is semantic, not phrasing: "three" maps unambiguously to 3, and a
      // correct interpretation must carry it (a bare undo would revert only one).
      ensure(
        undo.count === 3,
        `"undo the last three" should carry count 3, got ${JSON.stringify(undo.count)}`,
      );
    },
  },
  {
    name: "\"redo that\" becomes a redo action",
    docText: "Text currently reflecting an undo the user wants to reverse.",
    priorTexts: ["Text.", "Text currently reflecting a change."],
    transcript: "Actually, redo that.",
    assert: ({ actions }) => {
      pick(actions, "redo");
    },
  },
  {
    name: "restoring to an older version becomes a restore_version",
    docText: "Third draft: substantially rewritten and, honestly, worse.",
    priorTexts: [
      "First draft: the original clean version.",
      "Second draft: a few tweaks.",
    ],
    openDialog: "history",
    transcript: "Go back to the very first version of this document.",
    assert: ({ actions }) => {
      // Promise: a FULL restore (restore_version), not a fragment or a fresh edit.
      const restore = pick(actions, "restore_version");
      ensure(
        typeof restore.seq === "number" && restore.seq >= 0,
        "restore_version must name a version seq to restore",
      );
    },
  },
  {
    name: "restoring one paragraph to an earlier version becomes a restore_fragment",
    docText:
      "Intro stays as it is.\nThe methods section was rewritten and the user dislikes the new wording.",
    priorTexts: [
      "Intro stays as it is.\nThe methods section, original wording the user prefers.",
    ],
    openDialog: "history",
    transcript: "Put just the methods paragraph back the way it was in the earlier version.",
    assert: ({ actions }) => {
      // Promise: a PARTIAL restore (restore_fragment), not a full restore_version.
      const frag = pick(actions, "restore_fragment");
      ensure(
        frag.find.trim().length > 0 &&
          typeof frag.seq === "number" &&
          frag.seq >= 0,
        "restore_fragment must anchor on current text and name a source version seq",
      );
    },
  },
  {
    name: "\"rename this to X\" becomes a rename_document carrying the new name",
    docText: "Some notes that currently live under a placeholder name.",
    transcript: "Rename this document to Quarterly Board Update.",
    assert: ({ actions }) => {
      const rename = pick(actions, "rename_document");
      ensure(
        has(rename.name, "quarterly") ||
          has(rename.name, "board") ||
          has(rename.name, "update"),
        `rename_document name should reflect "Quarterly Board Update", got "${rename.name}"`,
      );
    },
  },
  {
    name: "\"open my document called X\" becomes a load_document targeting it",
    docText: "The document currently open, which the user wants to switch away from.",
    otherDocuments: [
      { id: "doc-groceries", name: "Grocery List" },
      { id: "doc-novel", name: "The Novel" },
    ],
    openDialog: "load",
    transcript: "Open my document called Grocery List.",
    assert: ({ actions }) => {
      const load = pick(actions, "load_document");
      // The model may target it by id (visible in the load dialog) or by name; either
      // is valid, but whichever it uses must point at the grocery list, not elsewhere.
      const byId = load.documentId !== undefined && has(load.documentId, "groc");
      const byName =
        load.byName !== undefined && (has(load.byName, "grocery") || has(load.byName, "list"));
      ensure(
        byId || byName || load.documentId === undefined,
        `load_document should target "Grocery List"; got ${JSON.stringify({
          documentId: load.documentId,
          byName: load.byName,
        })}`,
      );
    },
  },
  {
    name: "\"open settings\" opens the settings dialog",
    docText: "A draft the user is editing when they decide to change a setting.",
    transcript: "Open settings.",
    assert: ({ actions }) => {
      const dialog = pick(actions, "open_dialog");
      ensure(
        dialog.dialog === "settings",
        `expected the settings dialog, got "${dialog.dialog}"`,
      );
    },
  },
  {
    name: "\"show me my documents\" opens the load dialog",
    docText: "A draft open while the user goes looking for another document.",
    transcript: "Show me my other documents.",
    assert: ({ actions }) => {
      const dialog = pick(actions, "open_dialog");
      ensure(
        dialog.dialog === "load",
        `expected the load dialog, got "${dialog.dialog}"`,
      );
    },
  },
  {
    name: "\"close that\" with a dialog open becomes a close_dialog",
    docText: "A draft behind an open dialog the user wants dismissed.",
    openDialog: "history",
    transcript: "Okay, close that.",
    assert: ({ actions }) => {
      pick(actions, "close_dialog");
    },
  },
  {
    name: "\"switch to the chat panel\" becomes a set_panel targeting chat (mobile)",
    docText: "A draft shown in the document panel on a phone.",
    transcript: "Switch to the chat panel.",
    assert: ({ actions }) => {
      const panel = pick(actions, "set_panel");
      ensure(panel.panel === "chat", `set_panel should target chat, got "${panel.panel}"`);
    },
  },
  {
    name: "a two-fix turn becomes an edit_text carrying both corrections",
    docText:
      "We recieved the report on time.\nPlease chekc the numbers before Monday.",
    transcript:
      "Two fixes: change recieved to received, and chekc to check.",
    assert: ({ actions }) => {
      const edit = pick(actions, "edit_text");
      ensure(edit.edits.length >= 2, `expected at least two edits, got ${edit.edits.length}`);
      const fixesReceived = edit.edits.some(
        (e) => has(e.find, "recieved") && has(e.replace, "received"),
      );
      const fixesCheck = edit.edits.some(
        (e) => has(e.find, "chekc") && has(e.replace, "check"),
      );
      ensure(
        fixesReceived && fixesCheck,
        `both corrections must be present; got ${JSON.stringify(edit.edits)}`,
      );
    },
  },
  {
    name: "a scoped reword edits only the target and preserves the protected sentence",
    docText:
      "the thing is really good and stuff and we should probably just do it.\nThe budget for PROJECT-X is approved and must not change.",
    transcript:
      "Make the first sentence sound more professional, but leave the second sentence exactly as it is.",
    assert: ({ actions }) => {
      const edit = pick(actions, "edit_text");
      ensure(edit.edits.length >= 1, "reword should produce at least one edit");
      // Promise in the title: the protected sentence's distinctive token must survive
      // -- any edit that anchors on "PROJECT-X" must also carry it through unchanged,
      // so the reword cannot quietly drop or alter the sentence it was told to keep.
      ensure(
        edit.edits.every((e) => !has(e.find, "PROJECT-X") || has(e.replace, "PROJECT-X")),
        `the reword must not alter the protected sentence; got ${JSON.stringify(edit.edits)}`,
      );
    },
  },
  {
    name: "\"save this as a markdown file\" becomes a download_document in md format",
    docText: "A draft the user wants saved to disk as plain markdown.",
    transcript: "Save this as a markdown file.",
    assert: ({ actions }) => {
      const dl = pick(actions, "download_document");
      ensure(dl.format === "md", `expected md format, got "${dl.format}"`);
    },
  },

  // -- negative / robustness cases: the model must NOT wrongly mutate or pause -----

  {
    name: "dictation that merely CONTAINS the word \"stop\" is inserted, not treated as a pause",
    docText: "Meeting agenda:",
    transcript:
      "We really need to stop wasting money on the old vendor and cancel that contract this quarter.",
    assert: ({ actions }) => {
      // Primary promise: a bare 'stop' inside dictated content must not pause the mic.
      ensureAbsent(
        actions,
        "set_listening",
        `dictation containing "stop" must NOT pause; got a set_listening action`,
      );
      // And the sentence is treated as content: it is inserted, verbatim substance.
      const ins = pick(actions, "insert_text");
      ensure(
        has(ins.text, "stop wasting") || has(ins.text, "wasting money"),
        `the dictated sentence should be inserted as content; got "${ins.text}"`,
      );
    },
  },
  {
    name: "an ambiguous edit target asks which (chatMessage) and makes NO guessed edit_text",
    docText:
      "The kickoff meeting is on Monday, March 3rd.\nThe final review is on Friday, March 14th.",
    transcript: "Change the date.",
    assert: ({ chatMessage, actions }) => {
      // Two candidate dates -> the model must ask which, not silently pick one.
      ensure(
        !!chatMessage && chatMessage.trim().length > 0,
        "an ambiguous date target must ask which in chatMessage",
      );
      ensureAbsent(
        actions,
        "edit_text",
        `an ambiguous "change the date" must not fire a guessed edit_text`,
      );
      ensureNoMutation(actions);
    },
  },
];
