// Request-body validation at the HTTP edge. The Action envelope is validated by
// @yammer/core's parseLlmResponse; these schemas cover the plain REST bodies.

import { z } from "zod";
import { situationalContextSchema } from "@yammer/shared";

// POST /api/turn body. The prompt renderer dereferences context.recentChat (and
// other fields) unconditionally, so a malformed context ({}) would 500; validating
// the whole request here turns that into a clean 400. `sttMeta` is opaque diagnostic
// metadata (provider/interim flags) recorded verbatim, so it stays unknown.
export const turnRequestSchema = z.object({
  transcript: z.string(),
  context: situationalContextSchema,
  documentId: z.string().optional(),
  sttSeconds: z.number().optional(),
  sttMeta: z.unknown().optional(),
});

export const settingsSchema = z.object({
  theme: z.enum(["system", "light", "dark"]),
  loadDocSort: z.enum(["name", "created", "updated"]),
  sfxEnabled: z.boolean(),
  silenceThresholdMs: z.number().nonnegative(),
  optimisticSendMs: z.number().nonnegative(),
  chatCompactThreshold: z.number().int().positive(),
});

export const sortKeySchema = z.enum(["name", "created", "updated"]);

// Research fan-out bounds. Each query hits a paid search API (and each picked page
// a paid LLM digest), so cap both the number of queries and their length to close
// an unbounded real-dollar fan-out (plan.md sec 8). Small, deliberate limits.
export const MAX_RESEARCH_QUERIES = 5;
export const MAX_RESEARCH_QUERY_LENGTH = 200;

export const researchRequestSchema = z.object({
  queries: z
    .array(z.string().min(1).max(MAX_RESEARCH_QUERY_LENGTH))
    .min(1)
    .max(MAX_RESEARCH_QUERIES),
});

/** Sanitize a document name into a safe download filename. */
export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9-_ ]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 100) || "document"
  );
}
