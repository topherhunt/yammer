import type { AppState, ChatEntry, SituationalContext } from "@yammer/shared";

// Turns AppState into the situational-context payload sent to the LLM each turn.
// Pure and data-only so it is trivially unit-testable; the server renders it
// into the user message.

function numberLines(text: string): string {
  const lines = text.length ? text.split("\n") : [""];
  const width = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(width, " ")} | ${line}`)
    .join("\n");
}

function chatText(entry: ChatEntry): { role: string; text: string } {
  switch (entry.kind) {
    case "user_message":
      return { role: "user", text: entry.text };
    case "ai_message":
      return { role: "assistant", text: entry.text };
    case "thinking":
      return { role: "status", text: entry.status };
    case "edit":
      return { role: entry.author, text: `[edit] ${entry.summary}` };
    case "restore":
      return { role: entry.author, text: `[restore] ${entry.summary}` };
    case "research":
      return { role: "assistant", text: `[research] ${entry.summary}` };
    case "error":
      return { role: "system", text: `[error] ${entry.message}` };
  }
}

function summarizeHistory(state: AppState): string {
  if (state.history.length === 0) return "No edits yet.";
  const last = state.history.slice(-5);
  const lines = last.map((v) => `v${v.seq} (${v.author}, ${v.kind}): ${v.summary}`);
  const prefix =
    state.history.length > last.length
      ? `${state.history.length} versions total; most recent:\n`
      : "";
  return prefix + lines.join("\n");
}

function dialogContents(state: AppState): string {
  switch (state.openDialog) {
    case "load":
      return state.documents.length
        ? state.documents
            .map((d) => `- ${d.name} (created ${d.createdAt}, updated ${d.updatedAt})`)
            .join("\n")
        : "No documents yet.";
    case "history":
      return state.history.length
        ? state.history
            .map((v) => `- v${v.seq} (${v.author}, ${v.kind}): ${v.summary}`)
            .join("\n")
        : "No history yet.";
    case "menu":
      return "Menu: New document, Load document, Rename, Edit history, Help, Download diagnostic log.";
    case "help":
      return "Help: speak naturally to write, edit, navigate, or research. Say an explicit phrase like \"stop listening\" to pause; say \"Yammer, wake up\" to resume.";
    case null:
      return "";
  }
}

export function assembleContext(state: AppState): SituationalContext {
  const doc = state.activeDocument;
  return {
    document: doc
      ? {
          name: doc.name,
          lineCount: doc.text.length ? doc.text.split("\n").length : 0,
          numberedText: numberLines(doc.text),
        }
      : null,
    visible: doc
      ? {
          firstLine: state.documentScroll.firstVisibleLine,
          lastLine: state.documentScroll.lastVisibleLine,
        }
      : null,
    openDialog: state.openDialog
      ? { kind: state.openDialog, contents: dialogContents(state) }
      : null,
    activePanel: state.activePanel,
    listening: state.listening,
    chatSummary: state.chatSummary,
    // Everything since the checkpoint, verbatim. The checkpoint (chatSummarizedCount)
    // advances as the edge folds older chat into chatSummary, bounding this window.
    recentChat: state.chat.slice(state.chatSummarizedCount).map(chatText),
    historySummary: summarizeHistory(state),
  };
}
