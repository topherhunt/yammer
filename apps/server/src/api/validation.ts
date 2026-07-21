// Request-body validation at the HTTP edge. The Action envelope is validated by
// @yammer/core's parseLlmResponse; these schemas cover the plain REST bodies.

import { z } from "zod";

export const settingsSchema = z.object({
  theme: z.enum(["system", "light", "dark"]),
  loadDocSort: z.enum(["name", "created", "updated"]),
  sfxEnabled: z.boolean(),
  silenceThresholdMs: z.number().nonnegative(),
  optimisticSendMs: z.number().nonnegative(),
  chatCompactThreshold: z.number().int().positive(),
});

export const sortKeySchema = z.enum(["name", "created", "updated"]);

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
