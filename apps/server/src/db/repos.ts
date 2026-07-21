// Per-user data access. EVERY row except `users` is scoped to a userId and every
// query filters on it -- per-user isolation is a hard invariant (plan.md sec 4),
// enforced here and covered by tests. These repository SIGNATURES are the seam
// the API route handlers depend on.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
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

/**
 * Raised when a create/rename would collide with an existing document name for
 * the same user (case-insensitively). The route layer maps this to a 409 -- voice
 * addressing ("open my journal") depends on names being unambiguous (plan.md sec 4).
 */
export class DuplicateNameError extends Error {
  constructor(public readonly documentName: string) {
    super(`a document named "${documentName}" already exists`);
    this.name = "DuplicateNameError";
  }
}

/** Postgres unique-violation SQLSTATE. pg-mem sets the same `.code` (verified). */
export const PG_UNIQUE_VIOLATION = "23505";

/** True when an error is a Postgres/pg-mem unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

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
  /**
   * Append a version and advance the document head to it. When `undo` is given
   * (the client persists its live undo timeline alongside the version), the
   * document's undoStack/undoCursor are updated too; otherwise they are left
   * untouched (append alone cannot distinguish a forward edit from an undo/redo).
   */
  append(
    userId: string,
    version: Version,
    undo?: { undoStack: string[]; undoCursor: number },
  ): Promise<Version>;
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

  // Case-insensitive name lookup, the primitive behind duplicate-name detection.
  // Returns the ids of the user's documents whose name matches `name` ignoring case.
  async function idsWithName(userId: string, name: string): Promise<string[]> {
    const rows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.userId, userId),
          sql`lower(${documents.name}) = ${name.toLowerCase()}`,
        ),
      );
    return rows.map((r) => r.id);
  }

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

      // Names are case-insensitively unique per user (plan.md sec 4). An explicit
      // colliding name is a caller error -> DuplicateNameError (the route -> 409).
      // A nameless "new document" auto-disambiguates ("Untitled", "Untitled 2", ...)
      // so the bare voice command never fails against the unique index.
      let name: string;
      if (input.name !== undefined) {
        if ((await idsWithName(userId, input.name)).length > 0) {
          throw new DuplicateNameError(input.name);
        }
        name = input.name;
      } else {
        name = "Untitled";
        let n = 1;
        while ((await idsWithName(userId, name)).length > 0) {
          n += 1;
          name = `Untitled ${n}`;
        }
      }

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
      // Insert the document BEFORE the version: versions.document_id is now an FK to
      // documents(id), so the parent row must exist first. (current_version_id has no
      // FK, so pointing it at the not-yet-inserted version id is fine.)
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
      return {
        id: documentId,
        name,
        text: "",
        currentVersionId: initial.id,
        currentSeq: initial.seq,
      };
    },

    async rename(userId, documentId, name) {
      // Reject a case-insensitive collision with a DIFFERENT document (renaming a
      // doc to its own current name, or a case-only change, is allowed).
      const clashing = (await idsWithName(userId, name)).filter(
        (id) => id !== documentId,
      );
      if (clashing.length > 0) throw new DuplicateNameError(name);

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

    async append(userId, version, undo) {
      // Ownership backstop: never insert a version against a document the caller
      // does not own (do not trust the route to have checked). A version's userId
      // FK alone would accept a foreign document; this asserts the pairing.
      const ownerRows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.userId, userId),
            eq(documents.id, version.documentId),
          ),
        );
      if (!ownerRows[0]) {
        throw new Error(
          `Cannot append version: document ${version.documentId} not found for this user.`,
        );
      }

      // Insert the version. A UNIQUE(document_id, seq) violation from a truly
      // concurrent append surfaces here (23505) for the route to map to a 409.
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
      // The newly appended version becomes the document head (documents has no
      // text column -- the ActiveDocument text is read from the head version's
      // fullText). When the client supplies its undo timeline we persist it too;
      // otherwise undoStack/undoCursor are left untouched (a bare append cannot
      // tell a forward edit from an undo/redo navigation).
      const advanced = await db
        .update(documents)
        .set({
          currentVersionId: version.id,
          updatedAt: version.createdAt,
          ...(undo
            ? { undoStack: undo.undoStack, undoCursor: undo.undoCursor }
            : {}),
        })
        .where(
          and(
            eq(documents.userId, userId),
            eq(documents.id, version.documentId),
          ),
        )
        .returning({ id: documents.id });
      // A head advance that matched no row means the version "took" but the
      // document head did not move -- an edit that silently did not persist. Fail
      // loudly rather than return a version that isn't actually the head.
      if (advanced.length !== 1) {
        throw new Error(
          `Head advance for document ${version.documentId} affected ${advanced.length} rows, expected 1.`,
        );
      }
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
