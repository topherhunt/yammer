import type {
  ActiveDocument,
  DocumentMeta,
  LlmResult,
  Settings,
  SituationalContext,
  SortKey,
  Version,
} from "@yammer/shared";

// The surface the store's edge needs from the backend. Every method is scoped
// to the signed-in user server-side. The frontend slice ships the interface and
// a MockApiClient (below/in mock-client.ts); a fetch-backed implementation is
// wired at integrate time against apps/server's routes.

export interface TurnRequest {
  transcript: string;
  context: SituationalContext;
  /** The active document, so the server can log a diagnostic Turn against it. */
  documentId?: string;
  /** STT audio-seconds for this utterance, folded into the turn's usage. */
  sttSeconds?: number;
  /** Opaque STT provider metadata, persisted to the diagnostic log. */
  sttMeta?: unknown;
}

/** A document plus its append-only version history, as returned by load/create. */
export interface DocumentPayload {
  document: ActiveDocument;
  history: Version[];
}

/** The client's undo timeline, persisted alongside each version (N3). */
export interface PersistUndo {
  undoStack: string[];
  undoCursor: number;
}

/**
 * An HTTP failure that carries the numeric status, so the persist queue can
 * branch on 409 (seq-conflict -> reconcile) vs a transient error (retry). Thrown
 * by FetchApiClient on any non-2xx response; MockApiClient conforms by letting
 * tests throw errors that carry a `.status`.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiClient {
  /** POST /api/turn -- transcript + situational context in, structured LLM
   * result (unvalidated actions) out. The store validates with parseLlmResponse. */
  turn(req: TurnRequest): Promise<LlmResult>;

  listDocuments(sort: SortKey): Promise<DocumentMeta[]>;
  getDocument(
    documentId?: string,
    byName?: string,
    byDate?: string,
  ): Promise<DocumentPayload>;
  renameDocument(documentId: string, name: string): Promise<void>;
  /** Append a version to the doc's history. `undo` carries the client's undo
   * timeline (N3) so the server persists it alongside the snapshot. */
  persistVersion(version: Version, undo?: PersistUndo): Promise<void>;
  persistSettings(settings: Settings): Promise<void>;

  /** Runs the server research pipeline; returns only the digested findings note. */
  research(queries: string[]): Promise<string>;
  /** Server-rendered .docx bytes (marked -> HTML -> html-to-docx). */
  exportDocx(documentId: string): Promise<Blob>;
}
