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
  } | null;
  /** What is currently on screen in the document, for scroll-aware commands. */
  visible: { firstLine: number; lastLine: number } | null;
  openDialog: { kind: DialogKind; contents: string } | null;
  activePanel: Panel;
  listening: ListeningState;
  recentChat: { role: string; text: string }[];
  /** Compacted summary of edit history (not every diff). */
  historySummary: string;
}
