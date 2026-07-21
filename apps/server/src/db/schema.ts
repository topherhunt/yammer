// Drizzle table definitions. Every row except `users` carries a userId and every
// query filters on it -- per-user isolation is a hard invariant (plan.md sec 4).
//
// Timestamps are stored as ISO-8601 TEXT (not native timestamptz): the domain
// types (Version.createdAt, Turn.createdAt, ...) are all `string`, the core injects
// them as `new Date().toISOString()`, and text avoids driver timezone-coercion
// surprises. JSON payloads (settings, diff, actions, usage, ...) are jsonb.

import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type {
  DiffHunk,
  Settings,
  Usage,
  VersionKind,
  Author,
} from "@yammer/shared";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  settings: jsonb("settings").notNull().$type<Settings>(),
});

export const documents = pgTable("documents", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  currentVersionId: text("current_version_id"),
  // Undo timeline persisted per document (plan.md sec 4). undoStack is the
  // ordered version-id subsequence reachable by undo/redo; undoCursor indexes the
  // version the document currently reflects.
  undoStack: jsonb("undo_stack").notNull().$type<string[]>(),
  undoCursor: integer("undo_cursor").notNull(),
});

export const versions = pgTable("versions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  documentId: text("document_id").notNull(),
  seq: integer("seq").notNull(),
  parentVersionId: text("parent_version_id"),
  author: text("author").notNull().$type<Author>(),
  kind: text("kind").notNull().$type<VersionKind>(),
  summary: text("summary").notNull(),
  fullText: text("full_text").notNull(),
  diff: jsonb("diff").notNull().$type<DiffHunk[]>(),
  createdAt: text("created_at").notNull(),
  restoredFromVersionId: text("restored_from_version_id"),
});

export const turns = pgTable("turns", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  documentId: text("document_id").notNull(),
  createdAt: text("created_at").notNull(),
  transcript: text("transcript").notNull(),
  sttMeta: jsonb("stt_meta"),
  llmModel: text("llm_model").notNull(),
  llmRawResponse: jsonb("llm_raw_response"),
  actions: jsonb("actions").notNull().$type<unknown[]>(),
  chatMessage: text("chat_message"),
  usage: jsonb("usage").notNull().$type<Usage>(),
});

/** The full schema object, passed to drizzle() so the relational config is set. */
export const schema = { users, documents, versions, turns };
