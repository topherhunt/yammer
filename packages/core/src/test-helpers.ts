import type { AppState, Author } from "@yammer/shared";
import { initialState } from "@yammer/shared";
import { createVersion } from "./history";
import type { Ctx } from "./reducer";

const FIXED_NOW = "2026-07-21T00:00:00.000Z";

/** Deterministic context: monotonic ids, a fixed clock. */
export function makeCtx(author: Author = "ai"): Ctx {
  let n = 0;
  return {
    newId: () => `id${++n}`,
    now: () => FIXED_NOW,
    author,
  };
}

/** An AppState with one open document (seq-0 create version), ready to edit. */
export function docState(
  text: string,
  overrides: Partial<AppState> = {},
): AppState {
  const version = createVersion({
    id: "v0",
    createdAt: FIXED_NOW,
    documentId: "doc1",
    parent: null,
    author: "user",
    kind: "create",
    newText: text,
    summary: "Created document",
  });
  return initialState({
    activeDocument: {
      id: "doc1",
      name: "My Document",
      text,
      currentVersionId: version.id,
      currentSeq: version.seq,
    },
    history: [version],
    listening: "listening",
    ...overrides,
  });
}
