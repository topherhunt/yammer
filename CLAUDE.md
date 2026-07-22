# CLAUDE.md -- Yammer

Guidance for any AI agent working in this repo. Read this first, then `plan.md` (the full blueprint) and `vision.md` (the origin).

## What this is

**Yammer** is a 100% voice-driven, AI-driven text editor. The target user is a person with ALS who has lost most muscle function and wants to write, AI-chat, and research using only their voice. Mouse and keyboard work fully but are never *required*. Speech becomes text; text goes to an LLM with rich situational context; the LLM returns structured actions (edits, navigation, chat); the app applies them. Every edit is recorded in append-only history.

This is a real tool for a real person. Reliability and low friction matter more than cleverness. A dropped edit or a mic that won't restart is not a bug ticket -- it's someone losing their voice for the afternoon.

## Absolute rules

- **Never issue git write commands. Ever.** No `commit`, `branch`, `checkout`, `stash`, `reset`, `rebase`, `merge`, `push`, `add`/staging, `tag`, or anything that mutates history or the tree. Read-only git only (`log`, `diff`, `status`, `show`, `blame`). The user handles 100% of git. A prior "yes" never generalizes. This holds in every mode, including auto.
- **External API calls cost real dollars** (OpenAI, Tavily, etc.) -- distinct from the Claude-Code token budget. Before running anything that fans out real API calls (evals, batch jobs, the live-test tier, any SDK call in a loop over >~5 records), STOP and confirm with the user, with rough cost and runtime. Single-record dry runs under ~$0.50 are fine.
- **Never auto-commit at session end.** Run quality gates (tests, typecheck), summarize what changed and what's open, then let the user commit.

## Architecture (the load-bearing ideas)

1. **Everything the AI does is a structured `Action`.** The LLM never mutates state directly. It returns `{ chatMessage?, actions: Action[] }`, validated with Zod. A **pure reducer** `applyAction(state, action, ctx) -> { state, effects }` applies them. This is what makes the system testable, auditable, and safe. Do not let LLM output touch the DOM or DB directly -- it goes through the Action schema and the reducer.

   **Turn architecture (decided): client-authoritative reducer, thin relay server.** The browser is the only place the reducer runs (LLM turns AND direct edits -- one path, no double-apply). `/api/turn` is a thin relay: prompt in, raw `{chatMessage, actions, usage, raw}` out, plus a diagnostic `Turn` row. The client validates + `applyTurn` + persists each version via idempotent, seq-checked `POST /api/documents/:id/versions` (server enforces seq authority). See plan.md "Turn architecture".
2. **The pure core is the star.** `packages/core` (edit engine, reducer, history, context assembler) and `packages/shared` (types, Zod schemas, provider interfaces) have **zero** DOM/network/DB dependencies. Side effects are returned as `Effect[]` and handled at the edges. Maximize what lives here, because this is where the fast unit tests live. If you're tempted to import `fetch`, a DB client, or `document` into core, you're doing it wrong.
3. **Append-only history.** We store the **full text snapshot at every version** plus a computed diff for display. Restores and undo are new appended versions (like a git revert commit), never in-place mutation. Snapshots make restore/undo a trivial, corruption-proof row read -- we deliberately chose this over deltas/CRDT because space is cheap and correctness is not.
4. **Everything external is pluggable behind an interface.** `LlmProvider`, `SttProvider`, `SearchProvider` live in `packages/shared`. No provider-specific code leaks into domain logic. Swapping a model is a config string.

### Locked decisions (see plan.md for rationale)

- **Stack:** TypeScript everywhere. pnpm monorepo. React + Vite frontend, CodeMirror 6 editor, Zustand, Tailwind. Hono backend on Node. PostgreSQL + Drizzle. Google OAuth.
- **LLM:** GPT-5.6 **Luna** in dev, **Terra** in prod (same family = dev/prod parity), via OpenAI direct behind `LlmProvider`. Structured output, not free-form tool calls.
- **STT:** `gpt-realtime-whisper` (streaming transcription, $0.017/min) over a backend WebSocket proxy. NOT the speech-to-speech `gpt-realtime-2.1`. Web Speech is a desktop-Chrome-only fallback.
- **Voice UX:** tap-to-start gate; three states (listening / paused / muted). Pause keeps a local **Vosk** (`vosk-browser`) wake-word spotter alive -- open-source (Apache-2.0), keyless, 100% on-device; **"Yammer, wake up"** resumes hands-free. Stop is AI-interpreted from any *explicit* phrasing (bare "stop" must not pause). SFX on send and mute/unmute. Pause on tab-background, resume on foreground.
- **Research:** DIY pipeline (search -> LLM picks pages -> fetch -> summarize-to-notebook), default provider **Tavily**. Only the digested summary enters context, never raw pages. Never invoked unprompted.
- **Hosting:** self-hosted Racknerd VPS behind Caddy, new DB on the existing Postgres. Deployment is deferred; keep the server plain-`node`-runnable.
- **Features to remember:** per-document spend meter (STT + inference $) at the bottom of the chat sidebar; downloadable diagnostic log (transcripts -> raw LLM responses -> actions + full edit history); recency-fading yellow edit highlights so corrections are just the next edit.

## Code style

- **No em dashes.** Use `--` everywhere (code, comments, prose, commits).
- **No hard line wraps within a paragraph.** One line per paragraph/bullet; let the editor soft-wrap. Applies to Markdown and prose too.
- **Fail explicitly, not gracefully.** Surface problems loudly. Don't paper over expected-data problems with `?.`/`??`. Crash clearly when an invariant is violated (e.g. an edit anchor that doesn't match, or matches ambiguously, throws -- it does not silently no-op).
- **CSS is utility-first (Tailwind).** Compose from utilities before adding classes. A page-specific class only for a genuine multi-property, stateful component.
- **Scope discipline.** Implement what's asked, nothing speculative. Don't refactor working code or add abstractions for cases that can't happen. Three similar lines beat a premature abstraction. Clean up anything your change orphans; flag (don't silently delete) pre-existing dead code.
- **Read the actual code before changing or describing it.** Follow real imports and data flow; don't infer behavior from names. State what you haven't verified.

## Live-API tests & real-dollar spend (project-specific green light)

The user has explicitly authorized **limited** real API spend for a dedicated **live-API test tier** (real LLM/STT calls), separate from the default mocked suite. This narrowly overrides the global "confirm every external-dollar spend" default -- but only within the limits below. The mocked suite remains the default and stays free.

**Standing green light -- proceed WITHOUT asking only when ALL hold:**
- It's the dedicated live tier (gated by env, never part of normal `pnpm test`/CI).
- Estimated **total for the run is < $1.00**.
- Estimated **cost per individual test case is < $0.02** (2 cents).
- You have first **stated explicitly**: the model used, the number of API calls / test cases, the estimated cost per case, and the estimated total for the run.

**Ask the user FIRST if any of these:**
- Projected **total for a run >= $1.00**, or any **single case >= $0.02**.
- You are materially growing the case count, raising `YAMMER_LIVE_BUDGET_USD`, or running in a loop that compounds cost.
- Switching the eval model to a pricier tier (e.g. Terra/Sol vs Luna).

**Always:**
- The harness enforces a hard budget cap (`YAMMER_LIVE_BUDGET_USD`, default $0.50) that aborts the run if cumulative cost exceeds it.
- After each run, **report actual cost** (from returned `usage`) vs the estimate, and append a per-run line to `test-costs.jsonl` (gitignored).
- STT/audio live tests bill per audio-minute (~$0.017/min) -- keep clips to a few seconds.

Reference cost (per 1M tokens, input/output): gpt-5.6-luna $1/$6, terra $2.50/$15. A ~12-case LLM turn eval on Luna is roughly ~$0.05-0.10 per full run (each case ~half a cent), comfortably inside the standing green light.

## Testing

- Optimize for **"as much as possible covered by unit tests"** -- enabled by the pure core. Reducer, edit engine, history, context assembler, schema validation: all unit-tested with no browser/network.
- **Test titles are promises.** The test must verify what its name claims. No `expect(status).toBe(200)` as the only assertion -- assert against rendered content or returned data.
- **Use `qa-*` CSS classes as stable selectors** in E2E, never user-visible text (copy changes and breaks tests). Add `qa-*` hooks to templates when writing tests.
- For a bug fix, write the failing test that reproduces it first, then fix.
- Three test tiers: fast unit (default), mocked E2E (Playwright, STT+LLM mocked), and an **opt-in live-API tier** that hits real models -- always cost-accounted, hard-capped, and never in normal `pnpm test`/CI.
- Run tests + typecheck after changes before calling work done.

## Debugging (agent-readable logs)

Set env flags and reproduce; output goes to the terminal AND `yammer-debug.log` (repo root, gitignored) so you can read it directly instead of asking the user to paste:
- `YAMMER_TURN_DEBUG=1` -- each turn's transcript, LLM latency (ms), raw model response.
- `YAMMER_STT_DEBUG=1` -- the STT session config + every event OpenAI streams back (deltas, completions, rate errors).
- `VITE_VOSK_DEBUG=1` (web) -- wake-word hypotheses; these POST to `/api/debug` so they land in the same file. Add other client debug via `reportClientDebug()` (`apps/web/src/util/debug.ts`).
Central helper: `apps/server/src/debug.ts` (`debugLog(category, data)`).

## Lessons learned (don't re-introduce)

- **Turns are strictly serial and fully incorporated before the next.** Never let a subsequent LLM/turn read state a prior turn hasn't committed. Corollary: a state-changing op the next turn depends on (creating/switching a document) must be applied SYNCHRONOUSLY in the reducer, not deferred to an async effect -- doing the latter spawned duplicate documents.
- **Creation is client-authoritative, like every edit.** `new_document` builds the doc + its seq-0 `create` version in-state; that version persists through the normal queue and the server auto-creates the row from it (`documentName` rides along). Do NOT add a separate server-authoritative "mint a document" round-trip.
- **STT interim arrives as incremental deltas** -- accumulate them (server bridge) before showing; don't render each fragment as the whole transcript.
- **VAD end-of-speech is `redemptionMs` in `vad.ts`** (`VITE_VAD_REDEMPTION_MS`). Too low cuts people off mid-sentence; keep it generous (currently 2000ms).

## Collaboration

- Surface assumptions; if a request is ambiguous, name the readings rather than silently picking one.
- Push back constructively when you see a better approach. Respect a "no" -- don't re-apply a rejected change.
- Prefer the auto-approved file tools (Read/Edit/Write/Grep/Glob) over bash equivalents. Don't use `chmod`.

## Layout

```
packages/shared   # the contract: Action/AppState types, Zod schemas, provider interfaces (no deps but zod)
packages/core     # pure domain: edit engine, reducer, history, context assembler (+ unit tests)
apps/server       # Hono API, WS STT proxy, Postgres/Drizzle, auth, LLM/search adapters   (fan-out)
apps/web          # React/Vite UI, CodeMirror, voice pipeline, chat sidebar               (fan-out)
```

Build order: foundation (`shared` + `core`) is the frozen contract; the apps fan out against it. Don't add app-layer concerns to the core packages.
