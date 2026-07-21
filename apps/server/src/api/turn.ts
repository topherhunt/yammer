// POST /api/turn: the LLM turn loop.
//   assemble context -> call the injected LlmProvider -> validate the envelope ->
//   apply via the pure reducer -> persist the resulting Version(s) + a Turn row ->
//   return the actions/effects/state delta + usage.
// Nothing here mutates AppState directly; applyTurn (the pure core) does.

import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { AppState, Usage } from "@yammer/shared";
import { applyTurn, assembleContext, parseLlmResponse, type Ctx } from "@yammer/core";
import type { RouteDeps } from "./routes";
import { requireUser } from "../auth/session";
import { buildSystemPrompt, renderUserMessage } from "./prompt";

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
  const body = (await c.req.json().catch(() => null)) as {
    transcript?: unknown;
    state?: unknown;
    sttSeconds?: unknown;
    sttMeta?: unknown;
  } | null;

  if (
    !body ||
    typeof body.transcript !== "string" ||
    typeof body.state !== "object" ||
    body.state === null
  ) {
    return c.json({ error: "transcript (string) and state (object) are required" }, 400);
  }

  const transcript = body.transcript;
  const clientState = body.state as AppState;
  const sttSeconds = typeof body.sttSeconds === "number" ? body.sttSeconds : 0;
  const sttMeta = body.sttMeta ?? null;
  const model = process.env.LLM_MODEL ?? "gpt-5.6-luna";

  // Per-user isolation: an active document must belong to the caller. The DB is
  // authoritative for the document head + version history (seq numbering), so we
  // rebuild those from storage and keep only the client's ephemeral UI state
  // (undo timeline, chat, scroll, dialog). This prevents a stale/forged client
  // history from restarting seq numbers or colliding versions.
  const activeDoc = clientState.activeDocument;
  let state = clientState;
  if (activeDoc) {
    const owned = await deps.repos.documents.get(user.id, activeDoc.id);
    if (!owned) return c.json({ error: "document not found" }, 404);
    state = {
      ...clientState,
      activeDocument: owned,
      history: await deps.repos.versions.listForDocument(user.id, owned.id),
    };
  }

  const context = assembleContext(state);
  const llmResult = await deps.llm.complete({
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: renderUserMessage(context, transcript) }],
    model,
  });

  const parsed = parseLlmResponse({
    chatMessage: llmResult.chatMessage,
    actions: llmResult.actions,
  });

  if (!parsed.ok) {
    // Surface the failure (never silently swallow), but still record a diagnostic
    // turn so the bad model response is auditable in the diagnostic log.
    if (activeDoc) {
      await deps.repos.turns.append(user.id, {
        id: randomUUID(),
        userId: user.id,
        documentId: activeDoc.id,
        createdAt: new Date().toISOString(),
        transcript,
        sttMeta,
        llmModel: model,
        llmRawResponse: llmResult.raw,
        actions: [],
        usage: combineUsage(sttSeconds, llmResult.usage),
      });
    }
    return c.json({ error: `Invalid model response: ${parsed.error}` }, 422);
  }

  const ctx: Ctx = {
    newId: () => randomUUID(),
    now: () => new Date().toISOString(),
    author: "ai",
  };
  const result = applyTurn(state, parsed.response, ctx);

  // Persist append-only versions (each also advances the document head) and any
  // rename that changed the document's name.
  for (const effect of result.effects) {
    if (effect.type === "persist_version") {
      await deps.repos.versions.append(user.id, effect.version);
    } else if (effect.type === "rename_document") {
      await deps.repos.documents.rename(user.id, effect.documentId, effect.name);
    }
  }

  const usage = combineUsage(sttSeconds, llmResult.usage);

  if (activeDoc) {
    await deps.repos.turns.append(user.id, {
      id: randomUUID(),
      userId: user.id,
      documentId: activeDoc.id,
      createdAt: new Date().toISOString(),
      transcript,
      sttMeta,
      llmModel: model,
      llmRawResponse: llmResult.raw,
      actions: parsed.response.actions,
      ...(parsed.response.chatMessage !== undefined
        ? { chatMessage: parsed.response.chatMessage }
        : {}),
      usage,
    });
  }

  return c.json({
    chatMessage: parsed.response.chatMessage ?? null,
    actions: parsed.response.actions,
    effects: result.effects,
    state: result.state,
    usage,
    ...(result.error ? { error: result.error } : {}),
  });
}
