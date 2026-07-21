import type { Author, Version, VersionKind } from "@yammer/shared";
import { computeDiff } from "./diff";

// Append-only version helpers. IDs and timestamps are injected (never generated
// here) so the whole core stays pure and deterministic under test.

export interface NewVersionInput {
  id: string;
  createdAt: string; // ISO 8601
  documentId: string;
  parent: Version | null;
  author: Author;
  kind: VersionKind;
  newText: string;
  summary: string;
  restoredFromVersionId?: string;
}

export function createVersion(input: NewVersionInput): Version {
  const parentText = input.parent?.fullText ?? "";
  const version: Version = {
    id: input.id,
    documentId: input.documentId,
    seq: (input.parent?.seq ?? -1) + 1, // first (create) version is seq 0
    parentVersionId: input.parent?.id ?? null,
    author: input.author,
    kind: input.kind,
    summary: input.summary,
    fullText: input.newText,
    diff: computeDiff(parentText, input.newText),
    createdAt: input.createdAt,
  };
  if (input.restoredFromVersionId !== undefined) {
    version.restoredFromVersionId = input.restoredFromVersionId;
  }
  return version;
}

export function currentVersion(history: Version[]): Version | null {
  return history.length ? history[history.length - 1]! : null;
}

export function findVersion(history: Version[], id: string): Version | null {
  return history.find((v) => v.id === id) ?? null;
}
