import { z } from "zod";
import type { DialogKind, ListeningState, Panel } from "./state";

// The situational context payload the context assembler builds from AppState
// and sends to the LLM each turn. Kept as data (not prose) so it is trivially
// unit-testable; the server renders it into the user message.

export interface SituationalContext {
  document: {
    name: string;
    lineCount: number;
    /** Full current text with 1-based line-number prefixes for reliable addressing. */
    numberedText: string;
    /** The insertion cursor (the blue line): the line it's on plus a short window of
     * text immediately before/after it. Dictated content goes HERE by default. */
    cursor: { line: number; before: string; after: string };
  } | null;
  /** What is currently on screen in the document, for scroll-aware commands. */
  visible: { firstLine: number; lastLine: number } | null;
  openDialog: { kind: DialogKind; contents: string } | null;
  activePanel: Panel;
  listening: ListeningState;
  /** Rolling summary of the conversation before the checkpoint, so early
   * standing instructions are never wholly forgotten. Empty until first compaction. */
  chatSummary: string;
  /** Chat entries since the checkpoint, sent verbatim (not limited to a window;
   * the checkpoint advances as older chat is folded into chatSummary). */
  recentChat: { role: string; text: string }[];
  /** Compacted summary of edit history (not every diff). */
  historySummary: string;
  /** An older version the AI asked to read (read_version), with its full text,
   * so it can patch a fragment back in. Null unless a version was just read. */
  openedVersion: { seq: number; numberedText: string } | null;
}

/**
 * Zod schema mirroring SituationalContext, kept in lockstep with the interface
 * above. The server validates the client-supplied `context` on POST /api/turn with
 * this so a malformed body (e.g. `{}`, missing `recentChat`) is a clean 400 rather
 * than a 500 when the prompt renderer dereferences `recentChat.length`.
 */
export const situationalContextSchema = z.object({
  document: z
    .object({
      name: z.string(),
      lineCount: z.number(),
      numberedText: z.string(),
      cursor: z.object({
        line: z.number(),
        before: z.string(),
        after: z.string(),
      }),
    })
    .nullable(),
  visible: z
    .object({ firstLine: z.number(), lastLine: z.number() })
    .nullable(),
  openDialog: z
    .object({
      kind: z.enum(["menu", "help", "load", "history", "settings"]),
      contents: z.string(),
    })
    .nullable(),
  activePanel: z.enum(["chat", "document"]),
  listening: z.enum(["listening", "paused", "muted"]),
  chatSummary: z.string(),
  recentChat: z.array(z.object({ role: z.string(), text: z.string() })),
  historySummary: z.string(),
  openedVersion: z
    .object({ seq: z.number(), numberedText: z.string() })
    .nullable(),
});

// Compile-time guard that schema and interface stay consistent in both directions
// (the constraints fail the build if either side drifts).
type AssertExtends<A extends B, B> = true;
type _CtxFwd = AssertExtends<
  z.infer<typeof situationalContextSchema>,
  SituationalContext
>;
type _CtxBwd = AssertExtends<
  SituationalContext,
  z.infer<typeof situationalContextSchema>
>;
