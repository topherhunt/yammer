import type { Action, LlmResponse } from "@yammer/shared";
import { actionSchema, llmResponseSchema } from "@yammer/shared";

// Validate raw LLM output against the Action schema at the boundary. Malformed
// output is rejected with a clear, surfaced error -- never silently applied.

export type ParseResult =
  | { ok: true; response: LlmResponse }
  | { ok: false; error: string };

export function parseLlmResponse(raw: unknown): ParseResult {
  const parsed = llmResponseSchema.safeParse(raw);
  if (parsed.success) return { ok: true, response: parsed.data };

  const error = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error };
}

export type ParseActionResult =
  | { ok: true; action: Action }
  | { ok: false; error: string };

/** Validate ONE action (used when applying actions incrementally as they stream in
 * -- a malformed one is skipped, the valid ones already applied still stand, since
 * each is its own append-only version). */
export function parseAction(raw: unknown): ParseActionResult {
  const parsed = actionSchema.safeParse(raw);
  if (parsed.success) return { ok: true, action: parsed.data };
  const error = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error };
}
