// Per-user data access. EVERY row except `users` is scoped to a userId and every
// query filters on it -- per-user isolation is a hard invariant (plan.md sec 4),
// enforced here and covered by tests. These repository SIGNATURES are the seam
// the API route handlers depend on.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { createVersion } from "@yammer/core";
import {
  defaultSettings,
  type ActiveDocument,
  type DocumentMeta,
  type Settings,
  type SortKey,
  type Usage,
  type Version,
} from "@yammer/shared";
import { documents, schema, turns, users, versions } from "./schema";

/**
 * The drizzle handle the repos run against. Widened from the concrete
 * `PostgresJsDatabase` in the original seam to the shared `PgDatabase` base so
 * the prod postgres-js driver (index.ts) AND the pg-mem-backed pg-proxy driver
 * used by the tests both satisfy it -- the repos use only the core query builder
 * (select/insert/update), which lives on the base class. No other package imports
 * this type, so the widening is internal to apps/server.
 */
export type Database = PgDatabase<any, typeof schema>;

/** One `users` row per Google login; owns a JSONB `settings` bag. */
export interface User {
  id: string;
  googleSub: string;
  email: string;
  name: string;
  createdAt: string;
  settings: Settings;
}

/**
 * Append-only diagnostic + chat log row. Powers the chat sidebar, the spend
 * meter (SUM(usage) over a document's turns), and the diagnostic-log download.
 */
export interface Turn {
  id: string;
  userId: string;
  documentId: string;
  createdAt: string;
  transcript: string;
  sttMeta: unknown;
  llmModel: string;
  llmRawResponse: unknown;
  actions: unknown[];
  chatMessage?: string;
  usage: Usage;
}

export interface UsersRepo {
  findById(id: string): Promise<User | null>;
  findByGoogleSub(googleSub: string): Promise<User | null>;
  create(input: {
    googleSub: string;
    email: string;
    name: string;
  }): Promise<User>;
}

export interface DocumentsRepo {
  list(userId: string, sort: SortKey): Promise<DocumentMeta[]>;
  get(userId: string, documentId: string): Promise<ActiveDocument | null>;
  findByName(userId: string, name: string): Promise<DocumentMeta | null>;
  create(userId: string, input: { name?: string }): Promise<ActiveDocument>;
  rename(
    userId: string,
    documentId: string,
    name: string,
  ): Promise<DocumentMeta>;
}

export interface VersionsRepo {
  listForDocument(userId: string, documentId: string): Promise<Version[]>;
  get(userId: string, versionId: string): Promise<Version | null>;
  append(userId: string, version: Version): Promise<Version>;
}

export interface TurnsRepo {
  listForDocument(userId: string, documentId: string): Promise<Turn[]>;
  append(userId: string, turn: Turn): Promise<Turn>;
}

export interface SettingsRepo {
  get(userId: string): Promise<Settings>;
  update(userId: string, settings: Settings): Promise<Settings>;
}

/** The bundle of per-user repositories the API handlers receive as deps. */
export interface Repos {
  users: UsersRepo;
  documents: DocumentsRepo;
  versions: VersionsRepo;
  turns: TurnsRepo;
  settings: SettingsRepo;
}

// -- Row -> domain mappers -------------------------------------------------

type UserRow = typeof users.$inferSelect;
type DocumentRow = typeof documents.$inferSelect;
type VersionRow = typeof versions.$inferSelect;
type TurnRow = typeof turns.$inferSelect;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    googleSub: row.googleSub,
    email: row.email,
    name: row.name,
    createdAt: row.createdAt,
    settings: row.settings,
  };
}

function toDocumentMeta(row: DocumentRow): DocumentMeta {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVersion(row: VersionRow): Version {
  const version: Version = {
    id: row.id,
    documentId: row.documentId,
    seq: row.seq,
    parentVersionId: row.parentVersionId,
    author: row.author,
    kind: row.kind,
    summary: row.summary,
    fullText: row.fullText,
    diff: row.diff,
    createdAt: row.createdAt,
  };
  if (row.restoredFromVersionId !== null) {
    version.restoredFromVersionId = row.restoredFromVersionId;
  }
  return version;
}

function toTurn(row: TurnRow): Turn {
  const turn: Turn = {
    id: row.id,
    userId: row.userId,
    documentId: row.documentId,
    createdAt: row.createdAt,
    transcript: row.transcript,
    sttMeta: row.sttMeta,
    llmModel: row.llmModel,
    llmRawResponse: row.llmRawResponse,
    actions: row.actions,
    usage: row.usage,
  };
  if (row.chatMessage !== null) turn.chatMessage = row.chatMessage;
  return turn;
}

// -- Repository construction ----------------------------------------------

/** Build the repository bundle over a Drizzle database handle. */
export function createRepos(db: Database): Repos {
  const usersRepo: UsersRepo = {
    async findById(id) {
      const rows = await db.select().from(users).where(eq(users.id, id));
      return rows[0] ? toUser(rows[0]) : null;
    },
    async findByGoogleSub(googleSub) {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.googleSub, googleSub));
      return rows[0] ? toUser(rows[0]) : null;
    },
    async create(input) {
      const row: UserRow = {
        id: randomUUID(),
        googleSub: input.googleSub,
        email: input.email,
        name: input.name,
        createdAt: new Date().toISOString(),
        settings: { ...defaultSettings },
      };
      const inserted = await db.insert(users).values(row).returning();
      return toUser(inserted[0]!);
    },
  };

  const documentsRepo: DocumentsRepo = {
    async list(userId, sort) {
      // Date sorts render descending (plan.md sec 4); name sorts ascending.
      const order =
        sort === "name"
          ? asc(documents.name)
          : sort === "created"
            ? desc(documents.createdAt)
            : desc(documents.updatedAt);
      const rows = await db
        .select()
        .from(documents)
        .where(eq(documents.userId, userId))
        .orderBy(order);
      return rows.map(toDocumentMeta);
    },

    async get(userId, documentId) {
      const docRows = await db
        .select()
        .from(documents)
        .where(and(eq(documents.userId, userId), eq(documents.id, documentId)));
      const doc = docRows[0];
      if (!doc) return null;
      if (doc.currentVersionId === null) {
        throw new Error(
          `Document ${documentId} has no current version -- data invariant broken.`,
        );
      }
      const verRows = await db
        .select()
        .from(versions)
        .where(
          and(
            eq(versions.userId, userId),
            eq(versions.id, doc.currentVersionId),
          ),
        );
      const current = verRows[0];
      if (!current) {
        throw new Error(
          `Current version ${doc.currentVersionId} missing for document ${documentId}.`,
        );
      }
      return {
        id: doc.id,
        name: doc.name,
        text: current.fullText,
        currentVersionId: current.id,
        currentSeq: current.seq,
      };
    },

    async findByName(userId, name) {
      const rows = await db
        .select()
        .from(documents)
        .where(and(eq(documents.userId, userId), eq(documents.name, name)));
      return rows[0] ? toDocumentMeta(rows[0]) : null;
    },

    async create(userId, input) {
      const now = new Date().toISOString();
      const documentId = randomUUID();
      const name = input.name ?? "Untitled";
      const initial = createVersion({
        id: randomUUID(),
        createdAt: now,
        documentId,
        parent: null,
        author: "user",
        kind: "create",
        newText: "",
        summary: "Created document",
      });
      await db.insert(versions).values({
        id: initial.id,
        userId,
        documentId,
        seq: initial.seq,
        parentVersionId: initial.parentVersionId,
        author: initial.author,
        kind: initial.kind,
        summary: initial.summary,
        fullText: initial.fullText,
        diff: initial.diff,
        createdAt: initial.createdAt,
        restoredFromVersionId: null,
      });
      await db.insert(documents).values({
        id: documentId,
        userId,
        name,
        createdAt: now,
        updatedAt: now,
        currentVersionId: initial.id,
        undoStack: [initial.id],
        undoCursor: 0,
      });
      return {
        id: documentId,
        name,
        text: "",
        currentVersionId: initial.id,
        currentSeq: initial.seq,
      };
    },

    async rename(userId, documentId, name) {
      const now = new Date().toISOString();
      const updated = await db
        .update(documents)
        .set({ name, updatedAt: now })
        .where(and(eq(documents.userId, userId), eq(documents.id, documentId)))
        .returning();
      if (!updated[0]) {
        throw new Error(
          `Cannot rename: document ${documentId} not found for this user.`,
        );
      }
      return toDocumentMeta(updated[0]);
    },
  };

  const versionsRepo: VersionsRepo = {
    async listForDocument(userId, documentId) {
      const rows = await db
        .select()
        .from(versions)
        .where(
          and(
            eq(versions.userId, userId),
            eq(versions.documentId, documentId),
          ),
        )
        .orderBy(asc(versions.seq));
      return rows.map(toVersion);
    },

    async get(userId, versionId) {
      const rows = await db
        .select()
        .from(versions)
        .where(and(eq(versions.userId, userId), eq(versions.id, versionId)));
      return rows[0] ? toVersion(rows[0]) : null;
    },

    async append(userId, version) {
      const inserted = await db
        .insert(versions)
        .values({
          id: version.id,
          userId,
          documentId: version.documentId,
          seq: version.seq,
          parentVersionId: version.parentVersionId,
          author: version.author,
          kind: version.kind,
          summary: version.summary,
          fullText: version.fullText,
          diff: version.diff,
          createdAt: version.createdAt,
          restoredFromVersionId: version.restoredFromVersionId ?? null,
        })
        .returning();
      // The newly appended version becomes the document head. undoStack/undoCursor
      // are NOT touched here (append cannot tell a forward edit from an undo/redo
      // navigation); the client threads the live undo timeline within a session.
      await db
        .update(documents)
        .set({
          currentVersionId: version.id,
          updatedAt: version.createdAt,
        })
        .where(
          and(
            eq(documents.userId, userId),
            eq(documents.id, version.documentId),
          ),
        );
      return toVersion(inserted[0]!);
    },
  };

  const turnsRepo: TurnsRepo = {
    async listForDocument(userId, documentId) {
      const rows = await db
        .select()
        .from(turns)
        .where(
          and(eq(turns.userId, userId), eq(turns.documentId, documentId)),
        )
        .orderBy(asc(turns.createdAt));
      return rows.map(toTurn);
    },

    async append(userId, turn) {
      const inserted = await db
        .insert(turns)
        .values({
          id: turn.id,
          userId,
          documentId: turn.documentId,
          createdAt: turn.createdAt,
          transcript: turn.transcript,
          sttMeta: turn.sttMeta ?? null,
          llmModel: turn.llmModel,
          llmRawResponse: turn.llmRawResponse ?? null,
          actions: turn.actions,
          chatMessage: turn.chatMessage ?? null,
          usage: turn.usage,
        })
        .returning();
      return toTurn(inserted[0]!);
    },
  };

  const settingsRepo: SettingsRepo = {
    async get(userId) {
      const rows = await db
        .select({ settings: users.settings })
        .from(users)
        .where(eq(users.id, userId));
      if (!rows[0]) {
        throw new Error(`Cannot read settings: user ${userId} not found.`);
      }
      return rows[0].settings;
    },
    async update(userId, settings) {
      const updated = await db
        .update(users)
        .set({ settings })
        .where(eq(users.id, userId))
        .returning({ settings: users.settings });
      if (!updated[0]) {
        throw new Error(`Cannot update settings: user ${userId} not found.`);
      }
      return updated[0].settings;
    },
  };

  return {
    users: usersRepo,
    documents: documentsRepo,
    versions: versionsRepo,
    turns: turnsRepo,
    settings: settingsRepo,
  };
}
