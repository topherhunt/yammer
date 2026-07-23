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
    // The current cursor (insertion point). Use this for dictated continuations.
    z.literal("cursor"),
    // `occurrence` (1-based) disambiguates when the anchor repeats; without it,
    // a repeated anchor throws rather than silently inserting at the first match.
    z.object({
      afterFind: z.string().min(1),
      occurrence: z.number().int().positive().optional(),
    }),
  ]),
  text: z.string().min(1),
});

/** Move the insertion cursor (the blue line) without editing text. */
export const placeCursorAction = z.object({
  type: z.literal("place_cursor"),
  position: z.union([
    z.literal("start"),
    z.literal("end"),
    z.object({
      afterFind: z.string().min(1),
      occurrence: z.number().int().positive().optional(),
    }),
  ]),
});

export const restoreVersionAction = z.object({
  type: z.literal("restore_version"),
  // The version's seq -- the number shown in the edit history (v0, v1, ...). The
  // model can see seqs in context but never the opaque version IDs, so it
  // addresses versions by seq and the reducer resolves it to the version.
  seq: z.number().int().nonnegative(),
});

export const restoreFragmentAction = z.object({
  type: z.literal("restore_fragment"),
  seq: z.number().int().nonnegative(), // version seq (see restore_version)
  // `find` locates the fragment in the CURRENT text; `replace` is the text
  // pulled from the older version. Applied like an edit, tagged as a restore.
  find: z.string().min(1),
  replace: z.string(),
});

// Load an older version's full text into context (the vision's "read an older
// version so it can patch a specific part"). The AI reads a version, then on a
// following turn issues restore_fragment / edit_text with the exact old text.
export const readVersionAction = z.object({
  type: z.literal("read_version"),
  seq: z.number().int().nonnegative(),
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
  dialog: z.enum(["menu", "help", "load", "history", "settings"]),
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

// Change a user preference by voice ("switch to dark mode", "turn off sound
// effects"). Every field is optional -- only the provided ones are updated.
export const updateSettingsAction = z.object({
  type: z.literal("update_settings"),
  theme: z.enum(["system", "light", "dark"]).optional(),
  loadDocSort: z.enum(["name", "created", "updated"]).optional(),
  sfxEnabled: z.boolean().optional(),
  silenceThresholdMs: z.number().int().nonnegative().optional(),
  optimisticSendMs: z.number().int().nonnegative().optional(),
  chatCompactThreshold: z.number().int().positive().optional(),
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
  placeCursorAction,
  restoreVersionAction,
  restoreFragmentAction,
  readVersionAction,
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
  updateSettingsAction,
  researchAction,
  downloadDiagnosticsAction,
  clarifyAction,
]);

export type Action = z.infer<typeof actionSchema>;
export type ActionType = Action["type"];

/** The full envelope the LLM must return every turn.
 *
 * chatMessage is nullish, not just optional: the model is told to use it sparingly
 * (no message for routine scroll/menu/edit turns), and it expresses "no message"
 * as an explicit JSON `null` -- which a bare `.optional()` would REJECT, sinking an
 * otherwise-valid turn ("close the dialog" issues a valid action + null message).
 * Normalize null -> undefined so downstream only ever sees `string | undefined`. */
export const llmResponseSchema = z.object({
  chatMessage: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
  actions: z.array(actionSchema),
});
export type LlmResponse = z.infer<typeof llmResponseSchema>;
