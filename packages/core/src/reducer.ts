import type {
  Action,
  AppState,
  Author,
  ChatEntry,
  Effect,
  LlmResponse,
  Version,
} from "@yammer/shared";
import { applyEdits, applyInsert, EditError } from "./edit-engine";
import {
  createVersion,
  currentVersion,
  findVersion,
  findVersionBySeq,
} from "./history";

// The pure reducer. Given state + one validated action, it returns the next
// state and any Effect requests for the edges to perform. It never does I/O and
// never throws for expected failures (bad anchors, missing versions, no active
// document) -- those become error entries in the chat log.

/** Injected per turn so the core stays deterministic under test. */
export interface Ctx {
  newId(): string;
  now(): string; // ISO 8601
  author: Author; // who this action is attributed to ("ai" for LLM turns)
}

export interface ReduceResult {
  state: AppState;
  effects: Effect[];
  /**
   * Set when one or more actions in this result could not be applied (a missed
   * anchor, an unknown version, no open document, etc.). Multi-action turns are
   * deliberately BEST-EFFORT: a failed action surfaces an error entry and threads
   * state forward, and later independent actions still run -- so unrelated
   * dictation/edits are never discarded because some other action failed. This
   * field lets the edges (telemetry, diagnostic log, or a future atomic policy)
   * see that a turn had failures without inspecting chat entries.
   */
  error?: string;
}

const MAX_SUMMARY = 40;

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_SUMMARY
    ? oneLine.slice(0, MAX_SUMMARY - 1) + "…"
    : oneLine;
}

function withChat(state: AppState, entry: ChatEntry): AppState {
  return { ...state, chat: [...state.chat, entry] };
}

function errorResult(state: AppState, ctx: Ctx, message: string): ReduceResult {
  const next = withChat(state, {
    kind: "error",
    id: ctx.newId(),
    at: ctx.now(),
    message,
  });
  const effects: Effect[] = state.settings.sfxEnabled
    ? [{ type: "play_sfx", sound: "error" }]
    : [];
  return { state: next, effects, error: message };
}

function chatEntryFor(version: Version, ctx: Ctx): ChatEntry {
  // Any version with a source is a "went back/forward to a prior state" move
  // (restore/undo/redo); everything else is a plain edit.
  if (version.restoredFromVersionId !== undefined) {
    return {
      kind: "restore",
      id: ctx.newId(),
      at: ctx.now(),
      author: ctx.author,
      summary: version.summary,
      versionId: version.id,
      restoredFromVersionId: version.restoredFromVersionId,
    };
  }
  return {
    kind: "edit",
    id: ctx.newId(),
    at: ctx.now(),
    author: ctx.author,
    summary: version.summary,
    versionId: version.id,
  };
}

/** Append a version to the audit history, point the document at it, log the
 * attributed chat entry, and set the undo timeline -- the one place the
 * append-only invariant and the cursor bookkeeping live. */
function appendVersion(
  state: AppState,
  version: Version,
  undoStack: string[],
  undoCursor: number,
  ctx: Ctx,
): ReduceResult {
  const next: AppState = {
    ...state,
    activeDocument: {
      ...state.activeDocument!,
      text: version.fullText,
      currentVersionId: version.id,
      currentSeq: version.seq,
    },
    history: [...state.history, version],
    undoStack,
    undoCursor,
    // A committed edit consumes any version the AI had read for patching.
    readVersion: null,
    chat: [...state.chat, chatEntryFor(version, ctx)],
  };
  return { state: next, effects: [{ type: "persist_version", version }] };
}

/** A forward mutation (edit/insert/restore/rename): appends a new version and
 * pushes it as a new undo step, truncating any redo tail from the timeline. */
function commitVersion(
  state: AppState,
  ctx: Ctx,
  args: {
    newText: string;
    kind: Version["kind"];
    summary: string;
    restoredFromVersionId?: string;
  },
): ReduceResult {
  const doc = state.activeDocument!;
  const version = createVersion({
    id: ctx.newId(),
    createdAt: ctx.now(),
    documentId: doc.id,
    parent: currentVersion(state.history),
    author: ctx.author,
    kind: args.kind,
    newText: args.newText,
    summary: args.summary,
    ...(args.restoredFromVersionId !== undefined
      ? { restoredFromVersionId: args.restoredFromVersionId }
      : {}),
  });
  // Drop the redo tail (anything after the cursor), then push this step.
  const undoStack = [...state.undoStack.slice(0, state.undoCursor + 1), version.id];
  return appendVersion(state, version, undoStack, undoStack.length - 1, ctx);
}

/** Undo/redo: move the cursor to a version already on the timeline and append a
 * navigation version reflecting it, without changing the timeline itself. */
function commitNavigation(
  state: AppState,
  ctx: Ctx,
  kind: "undo" | "redo",
  targetCursor: number,
  steps: number,
): ReduceResult {
  const doc = state.activeDocument!;
  // Defensive: an inconsistent undo timeline (e.g. rebuilt from a partial load)
  // should surface an error, never crash the turn on a non-null assertion.
  const targetId = state.undoStack[targetCursor];
  const target = targetId ? findVersion(state.history, targetId) : null;
  if (!target) {
    return errorResult(state, ctx, "Undo timeline is inconsistent; cannot navigate.");
  }
  const version = createVersion({
    id: ctx.newId(),
    createdAt: ctx.now(),
    documentId: doc.id,
    parent: currentVersion(state.history),
    author: ctx.author,
    kind,
    newText: target.fullText,
    summary:
      steps === 1
        ? `${kind === "undo" ? "Undid" : "Redid"} 1 change`
        : `${kind === "undo" ? "Undid" : "Redid"} ${steps} changes`,
    restoredFromVersionId: target.id,
  });
  return appendVersion(state, version, state.undoStack, targetCursor, ctx);
}

/** Apply one validated action. */
export function applyAction(
  state: AppState,
  action: Action,
  ctx: Ctx,
): ReduceResult {
  switch (action.type) {
    case "edit_text": {
      if (!state.activeDocument) {
        return errorResult(state, ctx, "No document is open to edit.");
      }
      let newText: string;
      try {
        newText = applyEdits(state.activeDocument.text, action.edits);
      } catch (err) {
        if (err instanceof EditError) return errorResult(state, ctx, err.message);
        throw err;
      }
      const summary =
        action.edits.length === 1
          ? `Replaced "${truncate(action.edits[0]!.find)}" with "${truncate(action.edits[0]!.replace)}"`
          : `Applied ${action.edits.length} edits`;
      return commitVersion(state, ctx, { newText, kind: "edit", summary });
    }

    case "insert_text": {
      if (!state.activeDocument) {
        return errorResult(state, ctx, "No document is open to insert into.");
      }
      let newText: string;
      try {
        newText = applyInsert(state.activeDocument.text, action.position, action.text);
      } catch (err) {
        if (err instanceof EditError) return errorResult(state, ctx, err.message);
        throw err;
      }
      return commitVersion(state, ctx, {
        newText,
        kind: "edit",
        summary: `Inserted "${truncate(action.text)}"`,
      });
    }

    case "restore_version": {
      if (!state.activeDocument) {
        return errorResult(state, ctx, "No document is open to restore.");
      }
      const target = findVersionBySeq(state.history, action.seq);
      if (!target) {
        return errorResult(state, ctx, `No version with sequence ${action.seq}.`);
      }
      return commitVersion(state, ctx, {
        newText: target.fullText,
        kind: "restore",
        summary: `Restored to version ${target.seq}`,
        restoredFromVersionId: target.id,
      });
    }

    case "restore_fragment": {
      if (!state.activeDocument) {
        return errorResult(state, ctx, "No document is open to restore into.");
      }
      const target = findVersionBySeq(state.history, action.seq);
      if (!target) {
        return errorResult(state, ctx, `No version with sequence ${action.seq}.`);
      }
      // Provenance integrity: the restored fragment must actually be text from
      // the named version, or the audit log would record a "restore" of text
      // that never existed there.
      if (!target.fullText.includes(action.replace)) {
        return errorResult(
          state,
          ctx,
          `Restore fragment not found in version ${target.seq}; refusing to record an unfaithful restore.`,
        );
      }
      let newText: string;
      try {
        newText = applyEdits(state.activeDocument.text, [
          { find: action.find, replace: action.replace },
        ]);
      } catch (err) {
        if (err instanceof EditError) return errorResult(state, ctx, err.message);
        throw err;
      }
      return commitVersion(state, ctx, {
        newText,
        kind: "restore",
        summary: `Restored a fragment from version ${target.seq}`,
        restoredFromVersionId: target.id,
      });
    }

    case "read_version": {
      if (!state.activeDocument) {
        return errorResult(state, ctx, "No document is open to read a version from.");
      }
      const target = findVersionBySeq(state.history, action.seq);
      if (!target) {
        return errorResult(state, ctx, `No version with sequence ${action.seq}.`);
      }
      // Load the version's text into context; consumed (cleared) by the next edit.
      return {
        state: {
          ...state,
          readVersion: { seq: target.seq, text: target.fullText },
        },
        effects: [],
      };
    }

    case "undo": {
      if (!state.activeDocument) {
        return errorResult(state, ctx, "No document is open to undo.");
      }
      if (state.undoCursor <= 0) {
        return errorResult(state, ctx, "Nothing to undo.");
      }
      const steps = Math.min(action.count ?? 1, state.undoCursor);
      return commitNavigation(state, ctx, "undo", state.undoCursor - steps, steps);
    }

    case "redo": {
      if (!state.activeDocument) {
        return errorResult(state, ctx, "No document is open to redo.");
      }
      const maxCursor = state.undoStack.length - 1;
      if (state.undoCursor >= maxCursor) {
        return errorResult(state, ctx, "Nothing to redo.");
      }
      const steps = Math.min(action.count ?? 1, maxCursor - state.undoCursor);
      return commitNavigation(state, ctx, "redo", state.undoCursor + steps, steps);
    }

    case "download_document": {
      if (!state.activeDocument) {
        return errorResult(state, ctx, "No document is open to download.");
      }
      return {
        state,
        effects: [
          {
            type: "export_document",
            documentId: state.activeDocument.id,
            format: action.format,
          },
        ],
      };
    }

    case "new_document": {
      return {
        state,
        effects: [
          {
            type: "create_document",
            localId: ctx.newId(),
            ...(action.name !== undefined ? { name: action.name } : {}),
          },
        ],
      };
    }

    case "rename_document": {
      if (!state.activeDocument) {
        return errorResult(state, ctx, "No document is open to rename.");
      }
      const doc = state.activeDocument;
      const result = commitVersion(state, ctx, {
        newText: doc.text,
        kind: "rename",
        summary: `Renamed to "${truncate(action.name)}"`,
      });
      const renamed: AppState = {
        ...result.state,
        activeDocument: { ...result.state.activeDocument!, name: action.name },
        documents: result.state.documents.map((d) =>
          d.id === doc.id ? { ...d, name: action.name } : d,
        ),
      };
      return {
        state: renamed,
        effects: [
          ...result.effects,
          { type: "rename_document", documentId: doc.id, name: action.name },
        ],
      };
    }

    case "load_document": {
      return {
        state,
        effects: [
          {
            type: "load_document",
            ...(action.documentId !== undefined ? { documentId: action.documentId } : {}),
            ...(action.byName !== undefined ? { byName: action.byName } : {}),
            ...(action.byDate !== undefined ? { byDate: action.byDate } : {}),
          },
        ],
      };
    }

    case "open_dialog": {
      // The load dialog carries an optional sort that persists across opens.
      if (action.dialog === "load") {
        const sort = action.sort ?? state.settings.loadDocSort;
        const settingsChanged = sort !== state.settings.loadDocSort;
        const next: AppState = {
          ...state,
          openDialog: "load",
          settings: { ...state.settings, loadDocSort: sort },
        };
        const effects: Effect[] = [{ type: "load_documents", sort }];
        if (settingsChanged) {
          effects.push({ type: "persist_settings", settings: next.settings });
        }
        return { state: next, effects };
      }
      return { state: { ...state, openDialog: action.dialog }, effects: [] };
    }

    case "close_dialog":
      return { state: { ...state, openDialog: null }, effects: [] };

    case "set_panel":
      return { state: { ...state, activePanel: action.panel }, effects: [] };

    case "copy_document": {
      if (!state.activeDocument) {
        return errorResult(state, ctx, "No document is open to copy.");
      }
      return {
        state,
        effects: [{ type: "copy_to_clipboard", text: state.activeDocument.text }],
      };
    }

    case "set_listening": {
      const next: AppState = { ...state, listening: action.state };
      const effects: Effect[] = [{ type: "set_listening", state: action.state }];
      if (state.settings.sfxEnabled) {
        effects.push({
          type: "play_sfx",
          sound: action.state === "listening" ? "unmute" : "mute",
        });
      }
      return { state: next, effects };
    }

    case "scroll": {
      const target: "document" | "chat" =
        action.target === "active"
          ? state.activePanel === "chat"
            ? "chat"
            : "document"
          : action.target;
      return {
        state,
        effects: [
          {
            type: "scroll_to",
            target,
            direction: action.direction,
            amount: action.amount,
          },
        ],
      };
    }

    case "research": {
      const next = withChat(state, {
        kind: "thinking",
        id: ctx.newId(),
        at: ctx.now(),
        status: "Searching the web…",
      });
      return { state: next, effects: [{ type: "run_research", queries: action.queries }] };
    }

    case "download_diagnostics": {
      if (!state.activeDocument) {
        return errorResult(state, ctx, "No document is open to export diagnostics for.");
      }
      return {
        state,
        effects: [{ type: "download_diagnostics", documentId: state.activeDocument.id }],
      };
    }

    case "clarify": {
      const next = withChat(state, {
        kind: "ai_message",
        id: ctx.newId(),
        at: ctx.now(),
        text: action.question,
      });
      return { state: next, effects: [] };
    }
  }
}

/**
 * Fold a list of actions, threading state and accumulating effects. Best-effort
 * by design (see ReduceResult.error): every action runs even if an earlier one
 * failed, and all failures are collected into `error`.
 */
export function applyActions(
  state: AppState,
  actions: Action[],
  ctx: Ctx,
): ReduceResult {
  let current = state;
  const effects: Effect[] = [];
  const errors: string[] = [];
  for (const action of actions) {
    const result = applyAction(current, action, ctx);
    current = result.state;
    effects.push(...result.effects);
    if (result.error) errors.push(result.error);
  }
  return {
    state: current,
    effects,
    ...(errors.length ? { error: errors.join("; ") } : {}),
  };
}

/** Apply a whole validated LLM turn: the optional chat message, then actions. */
export function applyTurn(
  state: AppState,
  response: LlmResponse,
  ctx: Ctx,
): ReduceResult {
  let current = state;
  if (response.chatMessage) {
    current = withChat(current, {
      kind: "ai_message",
      id: ctx.newId(),
      at: ctx.now(),
      text: response.chatMessage,
    });
  }
  return applyActions(current, response.actions, ctx);
}
