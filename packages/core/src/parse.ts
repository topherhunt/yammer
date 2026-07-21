import type { LlmResponse } from "@yammer/shared";
import { llmResponseSchema } from "@yammer/shared";

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
