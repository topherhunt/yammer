// POST /api/turn: a THIN RELAY to the LLM.
//   build the system + user prompt from (context, transcript) -> call the injected
//   LlmProvider -> return the RAW envelope { chatMessage, actions (UNvalidated), usage,
//   raw }. The client owns the reducer + version persistence (client-authoritative
//   architecture), so nothing here runs applyTurn or appends a Version.
// The only write is a diagnostic Turn row (for the chat sidebar, spend meter, and
// diagnostic log), and only when a document the caller owns is named.

import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { Usage } from "@yammer/shared";
import { parseLlmResponse } from "@yammer/core";
import type { RouteDeps } from "./routes";
import { requireUser } from "../auth/session";
import { buildSystemPrompt, renderUserMessage } from "./prompt";
import { turnRequestSchema } from "./validation";
import { debugLog } from "../debug";

function combineUsage(sttSeconds: number, llmUsage: Usage): Usage {
  return {
    sttSeconds,
    inputTokens: llmUsage.inputTokens,
    cachedInputTokens: llmUsage.cachedInputTokens,
    outputTokens: llmUsage.outputTokens,
  };
}

export async function handleTurn(
  c: Context,
  deps: RouteDeps,
): Promise<Response> {
  const user = requireUser(c);
  const raw = await c.req.json().catch(() => null);

  // Validate transcript + the full SituationalContext up front. Without this a
  // malformed context (e.g. `{}`) 500s in renderUserMessage, which dereferences
  // context.recentChat.length unconditionally. A bad body is a clean 400 instead.
  const parsedBody = turnRequestSchema.safeParse(raw);
  if (!parsedBody.success) {
    return c.json(
      {
        error: "transcript (string) and context (SituationalContext) are required",
        detail: parsedBody.error.issues,
      },
      400,
    );
  }

  const { transcript, context } = parsedBody.data;
  const documentId = parsedBody.data.documentId;
  const sttSeconds = parsedBody.data.sttSeconds ?? 0;
  const sttMeta = parsedBody.data.sttMeta ?? null;
  const model = process.env.LLM_MODEL ?? "gpt-5.6-luna";
  // Set YAMMER_TURN_DEBUG=1 to log each turn's transcript, LLM latency, and the raw
  // model response -- the ground truth for diagnosing an "invalid LLM response".
  const debug = !!process.env.YAMMER_TURN_DEBUG;

  // Relay the turn to the model. A provider failure is surfaced (never swallowed)
  // as a 502 -- the client cannot apply a turn it never received.
  let llmResult;
  const startedAt = Date.now();
  try {
    llmResult = await deps.llm.complete({
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: renderUserMessage(context, transcript) }],
      model,
    });
  } catch (err) {
    if (debug) {
      debugLog("turn", {
        transcript,
        ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return c.json(
      { error: `LLM request failed: ${err instanceof Error ? err.message : String(err)}` },
      502,
    );
  }
  if (debug) {
    debugLog("turn", {
      transcript,
      ms: Date.now() - startedAt,
      actions: llmResult.actions,
      chatMessage: llmResult.chatMessage ?? null,
      raw: llmResult.raw,
    });
  }

  const usage = combineUsage(sttSeconds, llmResult.usage);

  // Parse purely for diagnostics/spend logging. The client is authoritative and
  // re-validates the raw actions itself, so a parse failure here does NOT change
  // what we relay -- we still return the raw envelope, just logging [] actions.
  const parsed = parseLlmResponse({
    chatMessage: llmResult.chatMessage,
    actions: llmResult.actions,
  });

  // Record a diagnostic Turn ONLY for a document the caller owns. A foreign or
  // missing documentId simply isn't logged -- the relay persists nothing to it.
  if (documentId) {
    const owned = await deps.repos.documents.get(user.id, documentId);
    if (owned) {
      await deps.repos.turns.append(user.id, {
        id: randomUUID(),
        userId: user.id,
        documentId,
        createdAt: new Date().toISOString(),
        transcript,
        sttMeta,
        llmModel: model,
        llmRawResponse: llmResult.raw,
        actions: parsed.ok ? parsed.response.actions : [],
        ...(parsed.ok && parsed.response.chatMessage !== undefined
          ? { chatMessage: parsed.response.chatMessage }
          : {}),
        usage,
      });
    }
  }

  return c.json({
    chatMessage: llmResult.chatMessage ?? null,
    actions: llmResult.actions,
    usage,
    raw: llmResult.raw,
  });
}
