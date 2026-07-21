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
  persistVersion(version: Version): Promise<void>;
  persistSettings(settings: Settings): Promise<void>;

  /** Runs the server research pipeline; returns only the digested findings note. */
  research(queries: string[]): Promise<string>;
  /** Server-rendered .docx bytes (marked -> HTML -> html-to-docx). */
  exportDocx(documentId: string): Promise<Blob>;
}
