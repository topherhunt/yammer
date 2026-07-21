-- Initial schema for the Yammer app database (plan.md sec 4).
-- Applied in prod via drizzle-kit; loaded verbatim into pg-mem by the test harness
-- (apps/server/src/test-support.ts), so this file is the single source of truth
-- for the table shapes both paths run against.

CREATE TABLE "users" (
  "id" text PRIMARY KEY NOT NULL,
  "google_sub" text NOT NULL UNIQUE,
  "email" text NOT NULL,
  "name" text NOT NULL,
  "created_at" text NOT NULL,
  "settings" jsonb NOT NULL
);

CREATE TABLE "documents" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "current_version_id" text,
  "undo_stack" jsonb NOT NULL,
  "undo_cursor" integer NOT NULL
);

CREATE TABLE "versions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "document_id" text NOT NULL,
  "seq" integer NOT NULL,
  "parent_version_id" text,
  "author" text NOT NULL,
  "kind" text NOT NULL,
  "summary" text NOT NULL,
  "full_text" text NOT NULL,
  "diff" jsonb NOT NULL,
  "created_at" text NOT NULL,
  "restored_from_version_id" text
);

CREATE TABLE "turns" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "document_id" text NOT NULL,
  "created_at" text NOT NULL,
  "transcript" text NOT NULL,
  "stt_meta" jsonb,
  "llm_model" text NOT NULL,
  "llm_raw_response" jsonb,
  "actions" jsonb NOT NULL,
  "chat_message" text,
  "usage" jsonb NOT NULL
);

CREATE INDEX "documents_user_idx" ON "documents" ("user_id");
CREATE INDEX "versions_doc_idx" ON "versions" ("user_id", "document_id", "seq");
CREATE INDEX "turns_doc_idx" ON "turns" ("user_id", "document_id", "created_at");
