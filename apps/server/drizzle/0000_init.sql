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

-- documents.user_id -> users(id) ON DELETE CASCADE: deleting a user removes their
-- documents (and, transitively via the versions/turns FKs, their history).
CREATE TABLE "documents" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "current_version_id" text,
  "undo_stack" jsonb NOT NULL,
  "undo_cursor" integer NOT NULL
);

-- versions FKs cascade from both users and documents. UNIQUE(document_id, seq) is
-- the true-concurrent seq-race backstop -- two clients racing the same next seq
-- cannot both persist (repos.append maps the resulting 23505 to a 409).
CREATE TABLE "versions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "document_id" text NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "parent_version_id" text,
  "author" text NOT NULL,
  "kind" text NOT NULL,
  "summary" text NOT NULL,
  "full_text" text NOT NULL,
  "diff" jsonb NOT NULL,
  "created_at" text NOT NULL,
  "restored_from_version_id" text,
  CONSTRAINT "versions_document_seq_unique" UNIQUE ("document_id", "seq")
);

CREATE TABLE "turns" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "document_id" text NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
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
-- Case-insensitive unique document names per user (plan.md sec 4): voice
-- addressing ("open my journal") depends on unambiguous names. pg-mem enforces
-- this functional unique index too (verified), so it backstops the repo pre-check.
CREATE UNIQUE INDEX "documents_user_lower_name_idx" ON "documents" ("user_id", lower("name"));
CREATE INDEX "versions_doc_idx" ON "versions" ("user_id", "document_id", "seq");
CREATE INDEX "turns_doc_idx" ON "turns" ("user_id", "document_id", "created_at");
