import type {
  DocumentMeta,
  LlmResult,
  Settings,
  SortKey,
  Version,
} from "@yammer/shared";
import { zeroUsage } from "@yammer/shared";
import type { ApiClient, DocumentPayload, TurnRequest } from "./client";

// In-memory API for local dev, demos, and tests. No network, no spend. Turn
// responses are scriptable so tests can drive exact LLM behavior; document
// data is a small in-memory store.

export interface MockApiConfig {
  /** Consumed FIFO by turn(); overridden by `turnResponder` when present. */
  turnResponses?: LlmResult[];
  turnResponder?: (req: TurnRequest) => LlmResult;
  documents?: DocumentMeta[];
  documentPayloads?: Record<string, DocumentPayload>;
  researchSummary?: string;
}

const emptyResult: LlmResult = { actions: [], usage: zeroUsage, raw: {} };

export class MockApiClient implements ApiClient {
  private turnQueue: LlmResult[];
  private readonly turnResponder?: (req: TurnRequest) => LlmResult;
  private documents: DocumentMeta[];
  private readonly payloads: Record<string, DocumentPayload>;
  private readonly researchSummary: string;

  /** Recorded calls, so tests can assert what the edge sent to the backend. */
  readonly persistedVersions: Version[] = [];
  readonly persistedSettings: Settings[] = [];
  readonly turnRequests: TurnRequest[] = [];

  constructor(config: MockApiConfig = {}) {
    this.turnQueue = [...(config.turnResponses ?? [])];
    this.turnResponder = config.turnResponder;
    this.documents = [...(config.documents ?? [])];
    this.payloads = { ...(config.documentPayloads ?? {}) };
    this.researchSummary = config.researchSummary ?? "No findings.";
  }

  async turn(req: TurnRequest): Promise<LlmResult> {
    this.turnRequests.push(req);
    if (this.turnResponder) return this.turnResponder(req);
    return this.turnQueue.shift() ?? emptyResult;
  }

  async listDocuments(sort: SortKey): Promise<DocumentMeta[]> {
    const docs = [...this.documents];
    docs.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      const key = sort === "created" ? "createdAt" : "updatedAt";
      // Date sorts render descending (newest first).
      return b[key].localeCompare(a[key]);
    });
    return docs;
  }

  async getDocument(
    documentId?: string,
    byName?: string,
  ): Promise<DocumentPayload> {
    if (documentId && this.payloads[documentId]) return this.payloads[documentId]!;
    if (byName) {
      const match = Object.values(this.payloads).find(
        (p) => p.document.name === byName,
      );
      if (match) return match;
    }
    const first = Object.values(this.payloads)[0];
    if (first) return first;
    throw new Error("MockApiClient: no document to load");
  }

  async renameDocument(documentId: string, name: string): Promise<void> {
    this.documents = this.documents.map((d) =>
      d.id === documentId ? { ...d, name } : d,
    );
  }

  async persistVersion(version: Version): Promise<void> {
    this.persistedVersions.push(version);
  }

  async persistSettings(settings: Settings): Promise<void> {
    this.persistedSettings.push(settings);
  }

  async research(_queries: string[]): Promise<string> {
    return this.researchSummary;
  }

  async exportDocx(_documentId: string): Promise<Blob> {
    return new Blob(["mock-docx"], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  }
}
