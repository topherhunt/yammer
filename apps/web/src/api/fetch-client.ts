import type {
  ActiveDocument,
  DocumentMeta,
  LlmResult,
  Settings,
  SortKey,
  Usage,
  Version,
} from "@yammer/shared";
import { ApiError } from "./client";
import type {
  ApiClient,
  DocumentPayload,
  PersistUndo,
  ResearchResult,
  TurnRequest,
} from "./client";

// The real backend client: a thin HTTP wrapper over apps/server's routes. The
// server is a THIN RELAY for turns and the authoritative store for documents;
// this client applies nothing itself -- the store owns the reducer and hands the
// resulting Version back via persistVersion. Every call carries the session
// cookie (credentials: "include") and fails explicitly on a non-2xx response.

/** Digested research response shape (apps/server/src/api/research.ts). */
interface ResearchResponse {
  note: string;
  sources: { title: string; url: string }[];
  usage: Usage;
}

export class FetchApiClient implements ApiClient {
  /** e.g. "https://yammer.example.com" or "" for same-origin. No trailing slash. */
  private readonly base: string;

  constructor(base: string) {
    this.base = base.replace(/\/$/, "");
  }

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  /** Fetch JSON, failing loudly on a non-2xx status (never silently degrade). */
  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url(path), {
      credentials: "include",
      ...init,
    });
    if (!res.ok) {
      throw new ApiError(
        `${init?.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  /** Shorthand for a JSON-body request (sets the content-type + serializes). */
  private jsonInit(method: string, body: unknown): RequestInit {
    return {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  async turn(req: TurnRequest): Promise<LlmResult> {
    const body: Record<string, unknown> = {
      transcript: req.transcript,
      context: req.context,
    };
    if (req.documentId !== undefined) body.documentId = req.documentId;
    if (req.sttSeconds !== undefined) body.sttSeconds = req.sttSeconds;
    if (req.sttMeta !== undefined) body.sttMeta = req.sttMeta;
    return this.requestJson<LlmResult>("/api/turn", this.jsonInit("POST", body));
  }

  async listDocuments(sort: SortKey): Promise<DocumentMeta[]> {
    const { documents } = await this.requestJson<{ documents: DocumentMeta[] }>(
      `/api/documents?sort=${encodeURIComponent(sort)}`,
    );
    return documents;
  }

  async getDocument(
    documentId?: string,
    byName?: string,
    byDate?: string,
  ): Promise<DocumentPayload> {
    const id = documentId ?? (await this.resolveDocumentId(byName, byDate));
    const [{ document }, { versions }] = await Promise.all([
      this.requestJson<{ document: ActiveDocument }>(`/api/documents/${id}`),
      this.requestJson<{ versions: Version[] }>(`/api/documents/${id}/versions`),
    ]);
    return { document, history: versions };
  }

  /** Resolve a name/date reference to a document id via the list endpoint. */
  private async resolveDocumentId(byName?: string, byDate?: string): Promise<string> {
    const { documents } = await this.requestJson<{ documents: DocumentMeta[] }>(
      "/api/documents",
    );
    if (byName) {
      const match = documents.find((d) => d.name === byName);
      if (!match) throw new Error(`No document named "${byName}".`);
      return match.id;
    }
    if (byDate) {
      // Match a document created or updated on the given date (ISO prefix).
      const match = documents.find(
        (d) => d.createdAt.startsWith(byDate) || d.updatedAt.startsWith(byDate),
      );
      if (!match) throw new Error(`No document dated "${byDate}".`);
      return match.id;
    }
    throw new Error("getDocument requires a documentId, byName, or byDate.");
  }

  async renameDocument(documentId: string, name: string): Promise<void> {
    await this.requestJson(
      `/api/documents/${documentId}`,
      this.jsonInit("PATCH", { name }),
    );
  }

  async persistVersion(version: Version, undo?: PersistUndo): Promise<void> {
    const body: Record<string, unknown> = { version };
    if (undo) {
      body.undoStack = undo.undoStack;
      body.undoCursor = undo.undoCursor;
    }
    await this.requestJson(
      `/api/documents/${version.documentId}/versions`,
      this.jsonInit("POST", body),
    );
  }

  async persistSettings(settings: Settings): Promise<void> {
    await this.requestJson("/api/settings", this.jsonInit("PUT", { settings }));
  }

  async research(queries: string[]): Promise<ResearchResult> {
    const { note, usage } = await this.requestJson<ResearchResponse>(
      "/api/research",
      this.jsonInit("POST", { queries }),
    );
    return { note, usage };
  }

  async exportDocx(documentId: string): Promise<Blob> {
    const res = await fetch(
      this.url(`/api/documents/${documentId}/export?format=docx`),
      { credentials: "include" },
    );
    if (!res.ok) {
      throw new Error(`export docx failed: ${res.status} ${res.statusText}`);
    }
    return res.blob();
  }

  async getDiagnostics(documentId: string): Promise<Blob> {
    const res = await fetch(
      this.url(`/api/documents/${documentId}/diagnostics`),
      { credentials: "include" },
    );
    if (!res.ok) {
      throw new Error(
        `diagnostics download failed: ${res.status} ${res.statusText}`,
      );
    }
    return res.blob();
  }
}
