import { z } from "zod";

// The Action protocol: the LLM never mutates state directly. It returns a
// validated envelope { chatMessage?, actions[] }; the pure reducer applies each
// action. Every schema here is the single source of truth -- TS types are
// inferred from these, never hand-written in parallel.

// -- Editing --------------------------------------------------------------

export const editTextAction = z.object({
  type: z.literal("edit_text"),
  // Anchored find/replace against the current document text. The model always
  // sees the current text, so anchors are stable. Ambiguous/missing anchors
  // fail loudly in the edit engine rather than silently no-op.
  edits: z
    .array(
      z.object({
        find: z.string().min(1),
        replace: z.string(),
        // 1-based; required only to disambiguate when `find` appears more than once.
        occurrence: z.number().int().positive().optional(),
      }),
    )
    .min(1),
});

export const insertTextAction = z.object({
  type: z.literal("insert_text"),
  position: z.union([
    z.literal("start"),
    z.literal("end"),
    // `occurrence` (1-based) disambiguates when the anchor repeats; without it,
    // a repeated anchor throws rather than silently inserting at the first match.
    z.object({
      afterFind: z.string().min(1),
      occurrence: z.number().int().positive().optional(),
    }),
  ]),
  text: z.string().min(1),
});

export const restoreVersionAction = z.object({
  type: z.literal("restore_version"),
  versionId: z.string().min(1),
});

export const restoreFragmentAction = z.object({
  type: z.literal("restore_fragment"),
  versionId: z.string().min(1),
  // `find` locates the fragment in the CURRENT text; `replace` is the text
  // pulled from the older version. Applied like an edit, tagged as a restore.
  find: z.string().min(1),
  replace: z.string(),
});

// Relative navigation along the undo timeline. `count` supports "undo the last
// three actions". Undo/redo move a cursor over the timeline rather than just
// toggling the two most recent states, so repeated undos walk backward.
export const undoAction = z.object({
  type: z.literal("undo"),
  count: z.number().int().positive().optional(),
});

export const redoAction = z.object({
  type: z.literal("redo"),
  count: z.number().int().positive().optional(),
});

// -- Document management --------------------------------------------------

export const newDocumentAction = z.object({
  type: z.literal("new_document"),
  name: z.string().min(1).optional(),
});

export const renameDocumentAction = z.object({
  type: z.literal("rename_document"),
  name: z.string().min(1),
});

export const loadDocumentAction = z.object({
  type: z.literal("load_document"),
  documentId: z.string().min(1).optional(),
  byName: z.string().min(1).optional(),
  byDate: z.string().min(1).optional(),
});

// -- Navigation / UI ------------------------------------------------------

export const scrollAction = z.object({
  type: z.literal("scroll"),
  target: z.enum(["document", "chat", "active"]).default("active"),
  direction: z.enum(["up", "down"]),
  amount: z.enum(["line", "page"]).default("page"),
});

// The single way to open any dialog. `sort` is only meaningful for the load
// dialog, where it sets and persists the document sort order.
export const openDialogAction = z.object({
  type: z.literal("open_dialog"),
  dialog: z.enum(["menu", "help", "load", "history"]),
  sort: z.enum(["name", "created", "updated"]).optional(),
});

export const closeDialogAction = z.object({ type: z.literal("close_dialog") });

export const setPanelAction = z.object({
  type: z.literal("set_panel"),
  panel: z.enum(["chat", "document"]),
});

export const copyDocumentAction = z.object({
  type: z.literal("copy_document"),
  // Copies the full document to the clipboard. The edge writes both a
  // plaintext and a rendered-HTML flavor; the core only carries the text.
});

// Download the document as a file. ".md" is the raw text; ".docx" is converted
// at the edge (marked -> HTML -> html-to-docx, no system binary needed).
export const downloadDocumentAction = z.object({
  type: z.literal("download_document"),
  format: z.enum(["md", "docx"]),
});

// -- Listening control ----------------------------------------------------

export const setListeningAction = z.object({
  type: z.literal("set_listening"),
  state: z.enum(["listening", "paused", "muted"]),
});

// -- Research -------------------------------------------------------------

export const researchAction = z.object({
  type: z.literal("research"),
  // Only ever emitted when the user explicitly asks; never autonomously.
  queries: z.array(z.string().min(1)).min(1),
});

// -- Meta -----------------------------------------------------------------

export const downloadDiagnosticsAction = z.object({
  type: z.literal("download_diagnostics"),
});

export const clarifyAction = z.object({
  type: z.literal("clarify"),
  // Ask rather than guess on ambiguous or destructive requests.
  question: z.string().min(1),
});

export const actionSchema = z.discriminatedUnion("type", [
  editTextAction,
  insertTextAction,
  restoreVersionAction,
  restoreFragmentAction,
  undoAction,
  redoAction,
  newDocumentAction,
  renameDocumentAction,
  loadDocumentAction,
  scrollAction,
  openDialogAction,
  closeDialogAction,
  setPanelAction,
  copyDocumentAction,
  downloadDocumentAction,
  setListeningAction,
  researchAction,
  downloadDiagnosticsAction,
  clarifyAction,
]);

export type Action = z.infer<typeof actionSchema>;
export type ActionType = Action["type"];

/** The full envelope the LLM must return every turn. */
export const llmResponseSchema = z.object({
  chatMessage: z.string().optional(),
  actions: z.array(actionSchema),
});
export type LlmResponse = z.infer<typeof llmResponseSchema>;
