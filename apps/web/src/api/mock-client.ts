import type {
  DocumentMeta,
  LlmResult,
  Settings,
  SortKey,
  Usage,
  Version,
} from "@yammer/shared";
import { zeroUsage } from "@yammer/shared";
import type {
  ApiClient,
  DocumentPayload,
  PersistUndo,
  ResearchResult,
  TurnRequest,
} from "./client";

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
  /** Usage the research pipeline reports as billed, folded into the spend meter. */
  researchUsage?: Usage;
  /** Bytes the diagnostics download resolves to; defaults to a small JSON blob. */
  diagnosticsBlob?: Blob;
  /** Called on every persistVersion attempt (1-based `attempt`) before the
   * version is recorded; throw to simulate a transient failure or a 409 (throw
   * an error carrying `.status`). Lets tests exercise the persist queue's retry
   * and reconcile paths without a real network. */
  persistFailer?: (attempt: number, version: Version) => void;
}

const emptyResult: LlmResult = { actions: [], usage: zeroUsage, raw: {} };

export class MockApiClient implements ApiClient {
  private turnQueue: LlmResult[];
  private readonly turnResponder?: (req: TurnRequest) => LlmResult;
  private documents: DocumentMeta[];
  private readonly payloads: Record<string, DocumentPayload>;
  private readonly researchSummary: string;
  private readonly researchUsage: Usage;
  private readonly diagnosticsBlob?: Blob;
  /** Queries passed to research(), so tests can assert what was requested. */
  readonly researchRequests: string[][] = [];
  /** Document ids passed to getDiagnostics(), so tests can assert the download. */
  readonly diagnosticsRequests: string[] = [];

  /** Recorded calls, so tests can assert what the edge sent to the backend. */
  readonly persistedVersions: Version[] = [];
  /** Undo timeline sent with each successful persistVersion (parallel to
   * persistedVersions), so tests can assert the N3 undo state was sent. */
  readonly persistedUndo: (PersistUndo | undefined)[] = [];
  readonly persistedSettings: Settings[] = [];
  readonly turnRequests: TurnRequest[] = [];
  /** Total persistVersion attempts (including ones that threw), for retry tests. */
  persistAttempts = 0;
  private readonly persistFailer?: (attempt: number, version: Version) => void;

  constructor(config: MockApiConfig = {}) {
    this.turnQueue = [...(config.turnResponses ?? [])];
    this.turnResponder = config.turnResponder;
    this.documents = [...(config.documents ?? [])];
    this.payloads = { ...(config.documentPayloads ?? {}) };
    this.researchSummary = config.researchSummary ?? "No findings.";
    this.researchUsage = config.researchUsage ?? zeroUsage;
    this.diagnosticsBlob = config.diagnosticsBlob;
    this.persistFailer = config.persistFailer;
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

  /** Document names sent with each persist (parallel to persistedVersions), so a
   * test can assert the seq-0 create carried the name for server auto-creation. */
  readonly persistedNames: (string | undefined)[] = [];

  async persistVersion(
    version: Version,
    undo?: PersistUndo,
    documentName?: string,
  ): Promise<void> {
    this.persistAttempts += 1;
    if (this.persistFailer) this.persistFailer(this.persistAttempts, version);
    this.persistedVersions.push(version);
    this.persistedUndo.push(undo);
    this.persistedNames.push(documentName);
  }

  async persistSettings(settings: Settings): Promise<void> {
    this.persistedSettings.push(settings);
  }

  async research(queries: string[]): Promise<ResearchResult> {
    this.researchRequests.push(queries);
    return { note: this.researchSummary, usage: this.researchUsage };
  }

  async exportDocx(_documentId: string): Promise<Blob> {
    return new Blob(["mock-docx"], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  }

  async getDiagnostics(documentId: string): Promise<Blob> {
    this.diagnosticsRequests.push(documentId);
    return (
      this.diagnosticsBlob ??
      new Blob([JSON.stringify({ document: documentId, turns: [], versions: [] })], {
        type: "application/json",
      })
    );
  }
}
