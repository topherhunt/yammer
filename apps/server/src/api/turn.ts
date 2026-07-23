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
  const llmReq = {
    system: buildSystemPrompt(),
    messages: [{ role: "user" as const, content: renderUserMessage(context, transcript) }],
    model,
  };
  const diagContext = { documentId, transcript, sttMeta, sttSeconds, model } as const;

  // Streamed turn: the client asks for it via Accept: text/event-stream. Relay the
  // model's output as it generates -- chat-message text live, then a final `done`
  // with the full validated result the client applies. Falls through to the plain
  // JSON path when the client doesn't ask or the provider can't stream.
  if (
    (c.req.header("accept") ?? "").includes("text/event-stream") &&
    typeof deps.llm.completeStreaming === "function"
  ) {
    return streamTurn(c, deps, user, llmReq, diagContext, debug);
  }

  // Relay the turn to the model. A provider failure is surfaced (never swallowed)
  // as a 502 -- the client cannot apply a turn it never received.
  let llmResult;
  const startedAt = Date.now();
  try {
    llmResult = await deps.llm.complete(llmReq);
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
  await writeDiagnosticTurn(deps, user.id, diagContext, llmResult, usage);

  return c.json({
    chatMessage: llmResult.chatMessage ?? null,
    actions: llmResult.actions,
    usage,
    raw: llmResult.raw,
  });
}

/** Fields the diagnostic Turn write + streaming path both need. */
interface DiagContext {
  documentId?: string;
  transcript: string;
  sttMeta: unknown;
  sttSeconds: number;
  model: string;
}

/** Record a diagnostic Turn ONLY for a document the caller owns. A foreign or
 * missing documentId simply isn't logged -- the relay persists nothing to it. */
async function writeDiagnosticTurn(
  deps: RouteDeps,
  userId: string,
  ctx: DiagContext,
  llmResult: { chatMessage?: string; actions: unknown[]; raw: unknown },
  usage: Usage,
): Promise<void> {
  if (!ctx.documentId) return;
  const owned = await deps.repos.documents.get(userId, ctx.documentId);
  if (!owned) return;
  // Parse purely for diagnostics; the client re-validates the raw actions itself.
  const parsed = parseLlmResponse({
    chatMessage: llmResult.chatMessage,
    actions: llmResult.actions,
  });
  await deps.repos.turns.append(userId, {
    id: randomUUID(),
    userId,
    documentId: ctx.documentId,
    createdAt: new Date().toISOString(),
    transcript: ctx.transcript,
    sttMeta: ctx.sttMeta,
    llmModel: ctx.model,
    llmRawResponse: llmResult.raw,
    actions: parsed.ok ? parsed.response.actions : [],
    ...(parsed.ok && parsed.response.chatMessage !== undefined
      ? { chatMessage: parsed.response.chatMessage }
      : {}),
    usage,
  });
}

/** Stream a turn as SSE: `data: {type:"chat", text}` events with the assistant's
 * message so far, then a final `data: {type:"done", chatMessage, actions, usage,
 * raw}` the client applies (or `{type:"error", message}`). */
function streamTurn(
  c: Context,
  deps: RouteDeps,
  user: { id: string },
  llmReq: { system: string; messages: { role: "user"; content: string }[]; model: string },
  ctx: DiagContext,
  debug: boolean,
): Response {
  const enc = new TextEncoder();
  const startedAt = Date.now();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        let acc = "";
        let lastChat = "";
        let emittedActions = 0;
        const llmResult = await deps.llm.completeStreaming!(llmReq, (delta) => {
          acc += delta;
          const chat = partialChatMessage(acc);
          // Only emit when the visible message text actually grew.
          if (chat !== lastChat) {
            lastChat = chat;
            send({ type: "chat", text: chat });
          }
          // Emit each action the moment its JSON object is complete, so the client
          // can apply it while the rest still generates.
          const actions = parseCompleteActions(acc);
          for (let k = emittedActions; k < actions.length; k++) {
            send({ type: "action", action: actions[k] });
          }
          emittedActions = actions.length;
        });
        if (debug) {
          debugLog("turn", {
            transcript: ctx.transcript,
            ms: Date.now() - startedAt,
            streamed: true,
            actions: llmResult.actions,
            chatMessage: llmResult.chatMessage ?? null,
            raw: llmResult.raw,
          });
        }
        const usage = combineUsage(ctx.sttSeconds, llmResult.usage);
        await writeDiagnosticTurn(deps, user.id, ctx, llmResult, usage);
        send({
          type: "done",
          chatMessage: llmResult.chatMessage ?? null,
          actions: llmResult.actions,
          usage,
          raw: llmResult.raw,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (debug) {
          debugLog("turn", { transcript: ctx.transcript, ms: Date.now() - startedAt, error: message });
        }
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** Extract the `chatMessage` string value (partial or complete) from the model's
 * partially-streamed JSON envelope, so we can show the reply as it types. Returns
 * "" until the string value begins. Handles JSON escapes; ignores a null value. */
export function partialChatMessage(text: string): string {
  const key = '"chatMessage"';
  const k = text.indexOf(key);
  if (k < 0) return "";
  let i = k + key.length;
  while (i < text.length && (text[i] === " " || text[i] === ":" || text[i] === "\n" || text[i] === "\t" || text[i] === "\r")) {
    i++;
  }
  if (text[i] !== '"') return ""; // null, or the value hasn't started
  i++;
  let out = "";
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      const n = text[i + 1];
      if (n === undefined) break; // escape split across chunks -- wait for more
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
      i++;
      continue;
    }
    if (ch === '"') break; // closing quote -- message complete
    out += ch;
  }
  return out;
}

/** Extract every COMPLETE action object from the model's partially-streamed JSON
 * `actions` array. Stops at the first still-incomplete object, so a half-written
 * action is never returned. String-aware brace matching (braces inside strings are
 * ignored). Malformed-but-balanced objects that fail JSON.parse stop the scan. */
export function parseCompleteActions(text: string): unknown[] {
  const k = text.indexOf('"actions"');
  if (k < 0) return [];
  let i = text.indexOf("[", k);
  if (i < 0) return [];
  i++; // past the '['
  const out: unknown[] = [];
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i]!)) i++;
    if (i >= text.length || text[i] === "]") break;
    if (text[i] !== "{") break; // not an object -- malformed; stop
    let depth = 0;
    let inStr = false;
    let esc = false;
    let complete = false;
    let j = i;
    for (; j < text.length; j++) {
      const ch = text[j]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          complete = true;
          break;
        }
      }
    }
    if (!complete) break; // this object is still streaming
    try {
      out.push(JSON.parse(text.slice(i, j + 1)));
    } catch {
      break;
    }
    i = j + 1;
  }
  return out;
}
