import type {
  ActiveDocument,
  DocumentMeta,
  LlmResult,
  Settings,
  SituationalContext,
  SortKey,
  Usage,
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

/** The digested research result: only the notebook note plus its billed usage
 * (raw pages never cross this seam). The usage is folded into the spend meter
 * exactly like a turn's usage. */
export interface ResearchResult {
  note: string;
  usage: Usage;
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

/** Live callbacks for a streamed turn. `onChat` gets the assistant's message so far
 * (replace, not append); `onAction` gets each complete, still-UNVALIDATED action as
 * its JSON closes (the store validates + applies each). */
export interface TurnStreamCallbacks {
  onChat: (text: string) => void;
  onAction: (action: unknown) => void;
}

export interface ApiClient {
  /** POST /api/turn -- transcript + situational context in, structured LLM
   * result (unvalidated actions) out. The store validates with parseLlmResponse. */
  turn(req: TurnRequest): Promise<LlmResult>;
  /** POST /api/turn as an SSE stream: the same final LlmResult as turn(), but the
   * assistant's message (`onChat`) and each COMPLETE action (`onAction`) arrive live
   * as the model generates, so both the reply and the edits appear without waiting
   * for the whole response. Optional -- the store falls back to turn() when absent. */
  turnStreaming?(req: TurnRequest, cb: TurnStreamCallbacks): Promise<LlmResult>;

  listDocuments(sort: SortKey): Promise<DocumentMeta[]>;
  getDocument(
    documentId?: string,
    byName?: string,
    byDate?: string,
  ): Promise<DocumentPayload>;
  renameDocument(documentId: string, name: string): Promise<void>;
  /** Append a version to the doc's history. `undo` carries the client's undo
   * timeline (N3) so the server persists it alongside the snapshot. `documentName`
   * is sent so the server can auto-create the document when this is its seq-0
   * "create" version (client-authoritative creation); ignored otherwise. */
  persistVersion(
    version: Version,
    undo?: PersistUndo,
    documentName?: string,
  ): Promise<void>;
  persistSettings(settings: Settings): Promise<void>;

  /** Runs the server research pipeline; returns only the digested findings note
   * plus the call's billed usage (folded into the spend meter). */
  research(queries: string[]): Promise<ResearchResult>;
  /** Server-rendered .docx bytes (marked -> HTML -> html-to-docx). */
  exportDocx(documentId: string): Promise<Blob>;
  /** GET /api/documents/:id/diagnostics -- the serialized diagnostic log
   * (transcripts -> raw LLM responses -> actions + full version history) as a
   * downloadable JSON blob. Mirrors exportDocx (bytes, not parsed JSON). */
  getDiagnostics(documentId: string): Promise<Blob>;
}
