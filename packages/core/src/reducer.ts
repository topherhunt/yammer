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
import { createVersion, currentVersion, findVersion } from "./history";

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

/** Commit a new document version: update the active doc, append to history, log
 * an attributed chat entry, and request persistence. Shared by every editing
 * action so the append-only invariant lives in exactly one place. */
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
  const parent = currentVersion(state.history);
  const version = createVersion({
    id: ctx.newId(),
    createdAt: ctx.now(),
    documentId: doc.id,
    parent,
    author: ctx.author,
    kind: args.kind,
    newText: args.newText,
    summary: args.summary,
    ...(args.restoredFromVersionId !== undefined
      ? { restoredFromVersionId: args.restoredFromVersionId }
      : {}),
  });

  const entry: ChatEntry =
    args.kind === "restore" && args.restoredFromVersionId !== undefined
      ? {
          kind: "restore",
          id: ctx.newId(),
          at: ctx.now(),
          author: ctx.author,
          summary: args.summary,
          versionId: version.id,
          restoredFromVersionId: args.restoredFromVersionId,
        }
      : {
          kind: "edit",
          id: ctx.newId(),
          at: ctx.now(),
          author: ctx.author,
          summary: args.summary,
          versionId: version.id,
        };

  const next: AppState = {
    ...state,
    activeDocument: {
      ...doc,
      text: args.newText,
      currentVersionId: version.id,
      currentSeq: version.seq,
    },
    history: [...state.history, version],
    chat: [...state.chat, entry],
  };

  return { state: next, effects: [{ type: "persist_version", version }] };
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
      const target = findVersion(state.history, action.versionId);
      if (!target) {
        return errorResult(state, ctx, `Version not found: ${action.versionId}`);
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
      const target = findVersion(state.history, action.versionId);
      if (!target) {
        return errorResult(state, ctx, `Version not found: ${action.versionId}`);
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
