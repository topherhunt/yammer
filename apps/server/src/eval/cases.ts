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
  type SituationalContext,
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
 * must NOT do when it should be asking a clarifying question instead of guessing. */
const MUTATING_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "edit_text",
  "insert_text",
  "restore_version",
  "restore_fragment",
  "undo",
  "redo",
]);

/** Fail if any document-mutating action was returned (used by the clarify case). */
function ensureNoMutation(actions: Action[]): void {
  const mutating = actions.filter((a) => MUTATING_ACTIONS.has(a.type));
  ensure(
    mutating.length === 0,
    `expected NO mutating action, but got: [${mutating.map((a) => a.type).join(", ")}]`,
  );
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

  const version = createVersion({
    id: "v0",
    createdAt: FIXED_AT,
    documentId: "doc-1",
    parent: null,
    author: "user",
    kind: "create",
    newText: c.docText,
    summary: "Created document",
  });

  const lineCount = c.docText.length ? c.docText.split("\n").length : 0;

  return initialState({
    activeDocument: {
      id: "doc-1",
      name: "Draft",
      text: c.docText,
      currentVersionId: version.id,
      currentSeq: version.seq,
    },
    documents: [
      { id: "doc-1", name: "Draft", createdAt: FIXED_AT, updatedAt: FIXED_AT },
    ],
    history: [version],
    undoStack: [version.id],
    undoCursor: 0,
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
    name: "an ambiguous request yields a clarify AND no mutating action (no guessed edit)",
    docText: "We should consider the proposal.\nIt has some merit but also risks.",
    transcript: "Fix it.",
    assert: ({ actions }) => {
      const clarify = pick(actions, "clarify");
      ensure(clarify.question.trim().length > 0, "clarify must ask a real question");
      // Promise in the title: clarifying INSTEAD OF guessing means the model must not
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
];
