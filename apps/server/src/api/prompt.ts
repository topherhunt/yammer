// Prompt assembly for the LLM turn loop and the research digest. Kept as plain
// string builders (the provider is injected and mocked in tests) so the wording
// can iterate without touching handler logic. The Action catalog mirrors the Zod
// schema in @yammer/shared -- the model's output is validated against it either way.

import type { SituationalContext } from "@yammer/shared";

export function buildSystemPrompt(): string {
  return [
    "You are Yammer, a voice-driven writing assistant for a user who edits entirely by speaking.",
    "Every transcript you receive is a COMMAND TO INTERPRET. Decide whether it is dictation to insert, an edit instruction, a navigation/UI command, a question, or chit-chat.",
    "",
    "Editing philosophy: maximally preserve the speaker's exact voice and wording. Only reword when explicitly asked.",
    "",
    "You never mutate the document directly. You return a JSON object { chatMessage?, actions[] } where each action is one of:",
    "- edit_text { edits: [{ find, replace, occurrence? }] } -- anchored find/replace against the current text.",
    "- insert_text { position: 'start' | 'end' | { afterFind }, text }",
    "- restore_version { versionId } / restore_fragment { versionId, find, replace }",
    "- undo { count? } / redo { count? }",
    "- new_document { name? } / rename_document { name } / load_document { documentId?, byName?, byDate? }",
    "- scroll { target, direction, amount } / open_dialog { dialog, sort? } / close_dialog / set_panel { panel }",
    "- copy_document / download_document { format: 'md' | 'docx' } / download_diagnostics",
    "- set_listening { state: 'listening' | 'paused' | 'muted' }",
    "- research { queries: string[] } -- ONLY when the user explicitly asks to search the web.",
    "- clarify { question } -- prefer this over guessing on ambiguous or destructive requests.",
    "",
    "Use chatMessage sparingly: not for routine scroll/menu/uncontroversial edits.",
    "Stopping the mic requires an EXPLICIT, unambiguous request; a bare 'stop' mid-sentence must NOT pause.",
  ].join("\n");
}

export function renderUserMessage(
  context: SituationalContext,
  transcript: string,
): string {
  const parts: string[] = [];

  if (context.document) {
    parts.push(
      `# Current document: ${context.document.name} (${context.document.lineCount} lines)`,
      context.document.numberedText,
    );
  } else {
    parts.push("# No document is currently open.");
  }

  if (context.visible) {
    parts.push(
      `# On screen: lines ${context.visible.firstLine}-${context.visible.lastLine}`,
    );
  }
  if (context.openDialog) {
    parts.push(
      `# Open dialog: ${context.openDialog.kind}`,
      context.openDialog.contents,
    );
  }

  parts.push(`# Listening state: ${context.listening}`);
  parts.push(`# Active panel: ${context.activePanel}`);

  if (context.chatSummary) {
    parts.push("# Earlier conversation (summary)", context.chatSummary);
  }
  if (context.recentChat.length) {
    parts.push(
      "# Recent conversation",
      context.recentChat.map((m) => `${m.role}: ${m.text}`).join("\n"),
    );
  }
  parts.push("# Edit history", context.historySummary);

  parts.push("# New transcript to interpret", transcript);

  return parts.join("\n\n");
}

export function buildResearchPrompt(): string {
  return [
    "You are Yammer's research assistant. You are given the user's search queries and the full text of a few web pages.",
    "Digest them into a single concise findings note the assistant can keep in its notebook.",
    "Return the note as `chatMessage` and an empty `actions` array.",
    "Summarize the substance; do NOT paste raw page text. Attribute concrete facts to their source when useful.",
  ].join("\n");
}

export function renderResearchInput(
  queries: string[],
  pages: { title: string; url: string; content: string }[],
): string {
  const parts: string[] = [`# Queries\n${queries.join("\n")}`];
  for (const p of pages) {
    parts.push(`# Source: ${p.title}\n${p.url}\n\n${p.content}`);
  }
  return parts.join("\n\n");
}
