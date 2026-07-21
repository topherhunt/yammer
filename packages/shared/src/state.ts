// The application state the pure reducer reads and writes, plus the Effect
// requests it emits for the edges (persistence, network, mic, audio) to carry
// out. Nothing here depends on the DOM, network, or a DB.

import { z } from "zod";

export type Theme = "system" | "light" | "dark";
export type SortKey = "name" | "created" | "updated";
export type DialogKind = "menu" | "help" | "load" | "history";
export type Panel = "chat" | "document";
export type ListeningState = "listening" | "paused" | "muted";
export type Author = "user" | "ai";
export type VersionKind =
  | "create"
  | "edit"
  | "restore"
  | "rename"
  | "undo"
  | "redo";

/** One line-level change, for display in the history list and chat log. */
export interface DiffHunk {
  kind: "add" | "remove" | "context";
  value: string;
}

/**
 * An append-only version. We store the full text at every version (bulletproof
 * restore/undo) plus a computed diff purely for display. History is never
 * mutated; restores/undo append a new version.
 */
export interface Version {
  id: string;
  documentId: string;
  seq: number; // monotonic per document; the create version is seq 0
  parentVersionId: string | null;
  author: Author;
  kind: VersionKind;
  summary: string; // human-readable, e.g. "Reworded paragraph 3"
  fullText: string;
  diff: DiffHunk[];
  createdAt: string; // ISO 8601
  restoredFromVersionId?: string;
}

/**
 * Zod schemas mirroring DiffHunk + Version, kept deliberately in lockstep with the
 * interfaces above (any field change must be made in both). The server validates a
 * client-supplied version envelope with `versionSchema` at the persistence edge, so
 * a malformed body is a clean 400 rather than an inconsistent snapshot or a 500 on a
 * NULL column. The `satisfies` assertions below fail the build if the shapes drift.
 */
export const diffHunkSchema = z.object({
  kind: z.enum(["add", "remove", "context"]),
  value: z.string(),
});

export const versionSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  seq: z.number().int().nonnegative(), // the create version is seq 0
  parentVersionId: z.string().nullable(),
  author: z.enum(["user", "ai"]),
  kind: z.enum(["create", "edit", "restore", "rename", "undo", "redo"]),
  summary: z.string(),
  fullText: z.string(),
  diff: z.array(diffHunkSchema),
  createdAt: z.string().min(1),
  restoredFromVersionId: z.string().optional(),
});

// Compile-time guard that schema and interface stay consistent in BOTH directions
// (an unused type alias never trips a lint, but a shape mismatch fails the build).
type AssertExtends<A extends B, B> = true;
type _DiffHunkFwd = AssertExtends<z.infer<typeof diffHunkSchema>, DiffHunk>;
type _DiffHunkBwd = AssertExtends<DiffHunk, z.infer<typeof diffHunkSchema>>;
type _VersionFwd = AssertExtends<z.infer<typeof versionSchema>, Version>;
type _VersionBwd = AssertExtends<Version, z.infer<typeof versionSchema>>;

/** Row shown in the Load Document dialog. */
export interface DocumentMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveDocument {
  id: string;
  name: string;
  text: string;
  currentVersionId: string;
  currentSeq: number;
}

/** Entries rendered in the chat sidebar. Edits/restores are attributed. */
export type ChatEntry =
  | { kind: "user_message"; id: string; at: string; text: string }
  | { kind: "ai_message"; id: string; at: string; text: string }
  | { kind: "thinking"; id: string; at: string; status: string }
  | {
      kind: "edit";
      id: string;
      at: string;
      author: Author;
      summary: string;
      versionId: string;
    }
  | {
      kind: "restore";
      id: string;
      at: string;
      author: Author;
      summary: string;
      versionId: string;
      restoredFromVersionId: string;
    }
  | { kind: "research"; id: string; at: string; summary: string }
  | { kind: "error"; id: string; at: string; message: string };

export interface ScrollState {
  firstVisibleLine: number;
  lastVisibleLine: number;
  totalLines: number;
}

export interface Settings {
  theme: Theme; // default "system" (follow OS/browser)
  loadDocSort: SortKey; // persisted silently; date sorts render descending
  sfxEnabled: boolean;
  silenceThresholdMs: number;
  optimisticSendMs: number;
  chatCompactThreshold: number; // messages since checkpoint before we summarize
}

export interface AppState {
  activeDocument: ActiveDocument | null;
  documents: DocumentMeta[];
  history: Version[]; // versions for the active document, oldest-first (append-only audit log)

  /**
   * Undo timeline. `undoStack` is the ordered list of version IDs reachable by
   * undo/redo (a subsequence of `history` -- forward edits push onto it; undo/redo
   * moves the cursor without pushing). `undoCursor` indexes the version the
   * document currently reflects. A new edit made while the cursor is behind the
   * tip truncates the redo tail from the stack (the discarded versions remain in
   * the append-only `history` for audit). This is what makes repeated undos walk
   * backward through the timeline instead of cycling between two states.
   */
  undoStack: string[];
  undoCursor: number; // -1 when no document is open

  openDialog: DialogKind | null;
  activePanel: Panel;
  listening: ListeningState;
  documentScroll: ScrollState;
  chatScroll: ScrollState;

  chat: ChatEntry[];
  /** Compacted summary of chat entries before the checkpoint, so early
   * instructions (e.g. "write in this style") survive out of the raw window. */
  chatSummary: string;
  /** How many leading chat entries are folded into chatSummary. Entries after
   * this index are sent to the LLM verbatim. Advanced by the edge when it
   * periodically summarizes older chat. */
  chatSummarizedCount: number;

  settings: Settings;
}

/** Sounds the UI plays; requested by the reducer, produced at the edge. */
export type SfxSound = "send" | "mute" | "unmute" | "error";

/**
 * Side-effect requests. The reducer stays pure by returning these instead of
 * performing I/O; the edges (server handlers, browser store) execute them and
 * dispatch any resulting follow-up actions.
 */
export type Effect =
  | { type: "persist_version"; version: Version }
  | { type: "create_document"; localId: string; name?: string }
  | {
      type: "load_document";
      documentId?: string;
      byName?: string;
      byDate?: string;
    }
  | { type: "load_documents"; sort: SortKey }
  | { type: "rename_document"; documentId: string; name: string }
  | { type: "run_research"; queries: string[] }
  | {
      type: "scroll_to";
      target: "document" | "chat";
      direction: "up" | "down";
      amount: "line" | "page";
    }
  | { type: "set_listening"; state: ListeningState }
  | { type: "copy_to_clipboard"; text: string }
  | { type: "export_document"; documentId: string; format: "md" | "docx" }
  | { type: "play_sfx"; sound: SfxSound }
  | { type: "persist_settings"; settings: Settings }
  | { type: "download_diagnostics"; documentId: string };

export const defaultSettings: Settings = {
  theme: "system",
  loadDocSort: "updated",
  sfxEnabled: true,
  silenceThresholdMs: 800,
  optimisticSendMs: 400,
  chatCompactThreshold: 24,
};

export const emptyScroll: ScrollState = {
  firstVisibleLine: 0,
  lastVisibleLine: 0,
  totalLines: 0,
};

/** A blank starting state, useful for tests and app bootstrap. */
export function initialState(overrides: Partial<AppState> = {}): AppState {
  return {
    activeDocument: null,
    documents: [],
    history: [],
    undoStack: [],
    undoCursor: -1,
    openDialog: null,
    activePanel: "document",
    listening: "muted",
    documentScroll: { ...emptyScroll },
    chatScroll: { ...emptyScroll },
    chat: [],
    chatSummary: "",
    chatSummarizedCount: 0,
    settings: { ...defaultSettings },
    ...overrides,
  };
}
