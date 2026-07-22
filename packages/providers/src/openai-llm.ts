// OpenAI (GPT-5.6 Luna/Terra) adapter for the frozen @yammer/shared LlmProvider
// interface, via the Responses API with JSON-schema structured output. The
// provider itself validates nothing beyond "is this a well-formed envelope" --
// callers validate each action against actionSchema from @yammer/shared. All
// OpenAI-specific code stays inside this file.

import OpenAI from "openai";
import { type LlmProvider, type LlmRequest, type LlmResult, type Usage } from "@yammer/shared";

/** Config for the real (OpenAI GPT-5.6 Luna/Terra) LLM provider. */
export interface LlmProviderConfig {
  apiKey: string;
  /** Model id, e.g. "gpt-5.6-luna" (dev) or "gpt-5.6-terra" (prod). */
  model: string;
  /** Override the API base URL (OpenRouter, a proxy, tests). */
  baseUrl?: string;
  /** Reasoning effort for the GPT-5 family. Lower = far lower latency (the model
   * "thinks" less before answering) at some cost to hard-reasoning accuracy. A UI
   * turn (map speech -> actions) is not a hard reasoning task, so we default LOW,
   * not the model's heavier default. Raise to "medium" if action accuracy slips. */
  reasoningEffort?: "low" | "medium" | "high";
}

// The structured-output contract sent to the Responses API. It pins the
// envelope shape { chatMessage?, actions[] }; the per-action union is left open
// here on purpose (each action carries a `type` discriminator) because the
// authoritative gate is the caller's Zod validation against actionSchema, and
// the full discriminated union is not expressible under strict Structured
// Outputs. The system prompt (assembled at the edge) carries the action catalog.
export const yammerTurnJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    chatMessage: {
      type: "string",
      description:
        "Optional chat message to the user. Use sparingly -- omit for routine, uncontroversial actions.",
    },
    actions: {
      type: "array",
      description:
        "The structured actions to apply this turn, in order. May be empty.",
      items: {
        type: "object",
        required: ["type"],
        properties: {
          type: {
            type: "string",
            description: "The action discriminator, e.g. \"edit_text\".",
          },
        },
      },
    },
  },
};

/** The subset of an OpenAI Responses `usage` object we read. Kept structural so
 * the mapping is unit-testable without constructing a full SDK response. */
export interface OpenAiUsageLike {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
}

/** The subset of an OpenAI Responses object we read. */
export interface OpenAiResponseLike {
  /** SDK convenience getter: the concatenated output text. */
  output_text: string;
  usage?: OpenAiUsageLike;
}

/**
 * Map an OpenAI Responses `usage` block onto the shared Usage type. `inputTokens`
 * is the full input count (which *includes* the cached tokens); `cachedInputTokens`
 * is the cached subset, priced at a discount downstream. STT is not an LLM concern,
 * so `sttSeconds` is 0. Throws if usage is absent -- we cannot report spend without it.
 */
export function mapOpenAiUsage(usage: OpenAiUsageLike | undefined): Usage {
  if (!usage) {
    throw new Error("OpenAI response is missing token usage; cannot report spend");
  }
  return {
    sttSeconds: 0,
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.output_tokens,
  };
}

/**
 * Extract and shape the structured envelope from an OpenAI Responses object.
 * Surfaces malformed output loudly (empty text, non-JSON, wrong shape) instead of
 * degrading -- a dropped turn must be visible, not silent. Does NOT validate the
 * individual actions; the caller does that against actionSchema.
 */
export function parseOpenAiResponse(response: OpenAiResponseLike): LlmResult {
  const text = response.output_text;
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("OpenAI response contained no output text");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `OpenAI response was not valid JSON: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OpenAI response JSON was not an object");
  }

  const envelope = parsed as { chatMessage?: unknown; actions?: unknown };

  // A response with no actions array is a CHAT-ONLY turn (the model chose to just
  // talk -- exactly what we ask it to do for chit-chat). Treat it as an empty action
  // list, never a hard failure: throwing here 502s the whole turn, which is how a
  // perfectly-valid "just replying" response was breaking the conversation.
  const actions = Array.isArray(envelope.actions) ? envelope.actions : [];

  let chatMessage: string | undefined;
  if (envelope.chatMessage !== undefined && envelope.chatMessage !== null) {
    if (typeof envelope.chatMessage !== "string") {
      throw new Error("OpenAI response \"chatMessage\" was not a string");
    }
    chatMessage = envelope.chatMessage;
  }

  return {
    chatMessage,
    actions,
    usage: mapOpenAiUsage(response.usage),
    raw: response,
  };
}

/**
 * Build the default LLM provider (OpenAI Responses API, structured output).
 * The returned provider validates nothing itself -- callers validate actions
 * against actionSchema from @yammer/shared.
 */
export function createLlmProvider(config: LlmProviderConfig): LlmProvider {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  // Latency knobs, config-first then env, with UI-tuned defaults. Turns run in the
  // interactive voice loop, so we bias hard toward responsiveness.
  const reasoningEffort =
    config.reasoningEffort ??
    (process.env.LLM_REASONING_EFFORT as LlmProviderConfig["reasoningEffort"]) ??
    "low";

  return {
    async complete(req: LlmRequest): Promise<LlmResult> {
      const response = await client.responses.create({
        // Per-request model wins; config.model is the default.
        model: req.model || config.model,
        instructions: req.system,
        input: req.messages.map((m) => ({ role: m.role, content: m.content })),
        // Cut latency: keep the model's "thinking" short for these routine
        // speech -> action turns rather than the heavier default effort.
        reasoning: { effort: reasoningEffort },
        // Cap output tokens when the caller sets a ceiling (the eval budget
        // harness does), so the most expensive dimension can't run to the model
        // default. Omitted entirely when unset -- the model's default applies.
        ...(req.maxTokens !== undefined ? { max_output_tokens: req.maxTokens } : {}),
        text: {
          format: {
            type: "json_schema",
            name: "yammer_turn",
            schema: yammerTurnJsonSchema,
            strict: false,
          },
        },
      });
      return parseOpenAiResponse(response);
    },
  };
}

/**
 * A deterministic LLM provider for tests: it replays canned results in order,
 * so a reducer/turn-loop test can drive an end-to-end flow with no network and
 * no spend. Never calls a real model. Throws once the canned results are
 * exhausted, so a test that makes more turns than it staged fails loudly.
 */
export class MockLlmProvider implements LlmProvider {
  private index = 0;

  constructor(private readonly cannedResults: LlmResult[] = []) {}

  async complete(_req: LlmRequest): Promise<LlmResult> {
    const next = this.cannedResults[this.index];
    if (next === undefined) {
      throw new Error(
        `MockLlmProvider has no canned result for call #${this.index + 1} ` +
          `(only ${this.cannedResults.length} staged)`,
      );
    }
    this.index++;
    return next;
  }
}
