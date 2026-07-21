# PLAN: Yammer -- a 100% voice-driven, AI-driven text editor

> Working blueprint. Derived from `vision.md`. Decisions marked **(assumed)** are my working defaults pending your confirmation -- see "Open questions / decisions needed" near the end. Decisions marked **(to verify)** need a live research/spike pass before we hardcode them.

---

## 1. What we are building

A web app where a person with severe motor impairment (ALS) can write, edit, AI-chat, and research using **only their voice**. Mouse and keyboard fully work but are never required. The user speaks; speech becomes text; text goes to an LLM along with rich situational context; the LLM returns a batch of structured actions (edits, navigation, chat messages); the app applies them. Every edit -- human or AI -- is recorded in an append-only history that can be inspected and restored by voice.

### Guiding principles

1. **Voice-first, not voice-only.** Every capability must be reachable by voice with low friction. The mouse/keyboard path is a fallback and a dev convenience, never the primary flow.
2. **Everything the AI does is a structured Action.** The LLM never mutates state directly. It emits JSON actions validated against a schema; a pure reducer applies them. This is what makes the system testable, auditable, and safe.
3. **Append-only history.** We never rewrite or lose an edit. Restores are new versions, like a git revert commit. No in-place mutation of history.
4. **Everything is pluggable behind an interface.** The STT engine and the LLM are both swappable via a thin provider interface. No provider-specific code leaks into domain logic.
5. **Maximize unit-testable surface.** The core (edit engine, action reducer, context assembler, history) is pure TypeScript with zero DOM/network dependencies, so the bulk of behavior is covered by fast unit tests. The browser/voice/network layers stay thin and are covered by a smaller E2E suite.
6. **Fail explicitly.** Invalid actions, failed edits, ambiguous references -> surface a clear error in the chat log, do not silently no-op or degrade.

---

## 2. Tech stack

| Layer | Choice | Why / alternatives |
|---|---|---|
| Language | TypeScript everywhere | Non-negotiable per vision. Shared types across FE/BE. |
| Monorepo | pnpm workspaces (`packages/core`, `apps/web`, `apps/server`, `packages/shared`) | Keeps the pure domain core isolated and independently testable. |
| Frontend | **React + Vite** | Ecosystem + editor library support matters more here than Solid's raw speed. CodeMirror/TipTap, testing tooling, and AI assistance are all richest on React. **(assumed)** |
| Editor surface | **CodeMirror 6** | Plain-text/markdown document model, robust programmatic change API (transactions), great large-doc performance, precise scroll/selection control, and a change model that maps cleanly onto our Action protocol. Alternative considered: TipTap/ProseMirror (richer formatting but heavier and harder for reliable LLM find/replace edits). |
| FE state | Zustand | Tiny, testable store; the app state is a plain object we can drive from tests. |
| Styling | Tailwind (utility-first) | Matches the "compose from utilities first" preference. Component classes only for genuine multi-state widgets (the listening indicator, chat bubbles). |
| Backend | **Hono** (on Node via `@hono/node-server`) | Yes, Hono is the modern pick you were reaching for: tiny, fast, first-class TS, runtime-portable. Express would also be fine; Hono wins on DX and types. |
| LLM providers | Provider abstraction over **OpenAI direct** (GPT-5.6 family) primary; Anthropic + OpenRouter adapters behind the same seam | Decision: dev = **GPT-5.6 Luna**, prod = **GPT-5.6 Terra** (see §11). Same family = dev/prod parity on tool-calling + structured output. Model is a config string; other providers are drop-in via the adapter. |
| STT (transcription) | **`gpt-realtime-whisper`** ($0.017/min, streaming) over a backend WebSocket, behind an `SttProvider` interface | This is the transcription-only streaming model -- NOT the pricey speech-to-speech `gpt-realtime-2.1` ($32/$64 per 1M audio tokens). Cheaper non-streaming alternatives (`gpt-4o-transcribe` $0.006/min, `gpt-4o-mini-transcribe` $0.003/min) are drop-in behind the same interface if we ever trade latency for cost. iOS/WebKit make Web Speech unreliable, so cloud STT is the cross-device default. See §7. |
| Wake word (restart-from-pause) | **Vosk (`vosk-browser`)** (WASM, on-device) | Fully open-source (Apache-2.0), **keyless, no registration**, runs 100% locally in-browser -- no audio leaves the device, no per-use cost, works on iOS/WebKit. ~40MB model (cached); more CPU than a purpose-built spotter but fine for a single pause-time phrase. Enables hands-free "resume listening" without a click. See §7. (Chosen over Picovoice Porcupine specifically to avoid a key/registration.) |
| Web search (research) | DIY pipeline behind a `SearchProvider` interface; default **Tavily** (or Exa) | We control the search -> pick -> fetch -> **summarize-to-notebook** flow ourselves rather than using the model's hosted `web_search` tool, so raw pages never bloat context and it stays provider-neutral. See §8. |
| Persistence | **PostgreSQL** + Drizzle ORM + migrations | Hosted, multi-user, multi-device sync. A new database on the existing VPS Postgres (see §15). Per-user isolation. Append-only version/event tables fit naturally. |
| Auth | **Google OAuth** (Sign in with Google) via Auth.js/Lucia-style session | One `users` row per Google login; all documents/history scoped to `userId`. HTTP-only session cookies. |
| Hosting | Self-hosted **Racknerd VPS** behind **Caddy** reverse proxy (see §15) | Node app + WS endpoint, Caddy routes by host and terminates TLS + proxies WebSockets. No Fly/Render. |
| Tests | **Vitest** (unit/integration) + **Playwright** (E2E) + a small **live-API tier** with cost accounting (§10) | Vitest for the pure core and server handlers; Playwright for browser + voice-mocked flows; a tagged subset hits real APIs and tracks $ per run. |

---

## 3. High-level architecture

```
                         ┌──────────────────────────────────────────────┐
   microphone ──audio──> │  Voice pipeline (browser)                    │
                         │  SttProvider -> interim/final transcript      │
                         └───────────────┬──────────────────────────────┘
                                         │ final transcript
                                         v
   ┌─────────────────────────────────────────────────────────────────┐
   │ Frontend (React)                                                  │
   │  - assembles Turn request: transcript + situational context      │
   │  - renders 2 panels: chat sidebar (L) + document (R)             │
   │  - applies validated Actions via the pure reducer                │
   └───────────────┬─────────────────────────────────────────────────┘
                   │ POST /api/turn  { transcript, context }
                   v
   ┌─────────────────────────────────────────────────────────────────┐
   │ Backend (Hono) -- Google-auth session on every request           │
   │  - WS /api/stt: proxy mic audio -> OpenAI Realtime transcription │
   │  - /api/turn: THIN RELAY -- build prompt, call LlmProvider,       │
   │    return raw { chatMessage, actions, usage, raw }; log Turn.     │
   │    (client validates + reduces + persists -- see below)          │
   │  - POST /api/documents/:id/versions: append-only, idempotent,    │
   │    seq-checked version persistence from the client                │
   │  - /api/research: web search + fetch + summarize (server-side)   │
   │  - /api/documents, /api/settings, /api/diagnostics, export        │
   │  - holds all API keys; nothing secret in the browser             │
   └───────────────┬─────────────────────────────────────────────────┘
                   │
      ┌────────────┴───────────┐        ┌──────────────────────────────┐
      │ PostgreSQL (users,     │        │ GPT-5.6 (Luna dev/Terra prod)│
      │ documents, versions,   │        │ + OpenAI Realtime STT        │
      │ turns, settings)       │        │ (provider abstraction)       │
      └────────────────────────┘        └──────────────────────────────┘
```

**Turn architecture: client-authoritative reducer, thin relay server (decided).** The browser holds `AppState` and is the single place the reducer runs -- for both LLM turns and direct mouse/keyboard edits, which the app requires anyway, so there is exactly one reducer path and no double-apply risk. Each turn: the client assembles `SituationalContext` (via `@yammer/core`), POSTs `{transcript, context, documentId?}`; the server relays to the LLM and returns the raw `{chatMessage, actions, usage, raw}` (logging a diagnostic `Turn` row for an owned document); the client validates with `parseLlmResponse`, applies via `applyTurn`, executes effects, and persists each resulting version through the idempotent, seq-checked `POST /api/documents/:id/versions` endpoint. The server stays authoritative for seq numbering (enforced at append) so a stale/forged client can't corrupt history. Durability against lost work comes from awaited idempotent persistence (versions carry full snapshots + client UUIDs, so retries are safe).

**The `packages/core` module is the star.** It contains, as pure functions with no I/O:
- the Action type definitions + Zod schema (the contract),
- the **edit engine** (apply a text edit, produce a new version),
- the **action reducer** `(AppState, Action) -> {AppState, Effect[]}`,
- the **context assembler** that turns AppState into the LLM's situational-context payload,
- the **history/version** model and restore logic.

Because this is pure, ~80% of behavior is unit-testable with no browser and no network.

---

## 4. Domain & data model

Multi-user, hosted, Postgres. Every row below except `User` is scoped to a `userId` and every query filters on it (per-user isolation is a hard invariant, enforced in the data layer and covered by tests).

### Entities

- **User**: `id`, `googleSub`, `email`, `name`, `createdAt`, and a **`settings` JSONB** column (an open bag so we can add fields without migrations). Known keys so far: `theme` (`'system' | 'light' | 'dark'`, default `'system'` = follow OS/browser), `loadDocSort` (`'name' | 'created' | 'updated'`, default `'updated'`; date sorts are always descending) which persists silently so the Load dialog reopens with the last-used sort even though it has no settings-dialog UI, `activeDocumentId`, `model` config, `sttProvider`, and voice-tuning params (silence threshold, optimistic-send delay).
- **Document**: `id`, `userId`, `name`, `createdAt`, `updatedAt`, `currentVersionId`.
- **Version** (append-only event): `id`, `userId`, `documentId`, `seq` (monotonic per doc), `parentVersionId`, `author` (`'user' | 'ai'`), `kind` (`'edit' | 'create' | 'restore' | 'rename'`), `summary` (human-readable, e.g. "Reworded paragraph 3"), `fullText` (the complete document text at this version), `diff` (computed unified/word diff vs parent, for display), `createdAt`, and optional `restoredFromVersionId`.
- **Turn** (append-only diagnostic + chat log): `id`, `userId`, `documentId`, `createdAt`, `transcript` (raw STT text sent), `sttMeta` (provider, audio seconds, interim-vs-final), `llmModel`, `llmRawResponse` (full JSON the model returned), `actions` (validated Action[] applied), `chatMessage`, `usage` (`{ sttSeconds, sttCost, inTokens, outTokens, cachedTokens, llmCost }`). This single table powers the chat sidebar, the spend meter, and the downloadable diagnostic log -- so those features are byproducts of data we already persist, not extra plumbing.

### Spend meter (per document)

The small gray total at the bottom of the chat sidebar is `SUM(usage)` over the document's `Turn` rows: STT audio-seconds x rate + inference tokens x rate (input/cached/output priced separately per the active model). Computed, not separately tracked. Shown as tokens + estimated USD.

### Diagnostic log download

"Download full diagnostic log" (menu click or voice) serializes this document's `Turn` rows (transcript -> raw LLM response -> resulting actions) plus the full `Version` history into a single JSON (and a human-readable rendering) file the user can email for troubleshooting. It's just a query + serialize over the append-only tables.

### Why full-text snapshots per version (the "battle-tested edit tracking" call)

Your vision worries about storing only deltas to save space while guaranteeing corruption-free replay. Those two goals are in tension: deltas save space but carry replay/merge/corruption risk; snapshots are bulletproof but bigger. Per user the space cost is negligible -- a 50-page doc is ~120 KB, so even 500 revisions is ~60 MB, trivial on disk (and it's one low-volume user). So the right engineering call is:

- **Store the full text at every version** (bulletproof: restore = read a row, no replay).
- **Also store a computed diff** vs the parent purely for display in the history list and chat log.
- Restores and partial restores (e.g. "restore the 3rd paragraph to a few edits ago") are implemented as: read the old version's text, compute the new full text, append a new `kind: 'restore'` version. History is never mutated -- exactly your git-like requirement.
- **Undo/redo walk a cursor over the timeline, so repeated undos don't cycle.** Alongside the append-only `history`, state holds an `undoStack` (the ordered version IDs reachable by undo/redo) and an `undoCursor` (the version the document currently reflects). Undo moves the cursor back (by `count`, for "undo the last three actions") and appends a new `kind: 'undo'` version reflecting that older text; it does *not* push onto the stack, so the *next* undo goes back another step rather than undoing the undo. Redo moves the cursor forward. A brand-new edit made while the cursor is behind the tip truncates the redo tail from the stack (the discarded versions stay in `history` for audit) and starts a fresh branch -- exactly how a text editor's undo behaves. Because we store the full snapshot at every step, each move is a corruption-proof row read; no diff-inversion. Pinned by tests in `reducer.test.ts`.

This gives us the git-like append-only semantics and the "no risk of corruption" guarantee, and it is far simpler and safer than a delta/CRDT replay engine. If disk ever matters we can add snapshot-compaction later (keep every Nth full snapshot + deltas between) without changing the public API. I recommend we **not** reach for Yjs/Automerge/ProseMirror-steps here: those shine for real-time multi-user collaboration, which we do not have.

---

## 5. The Action protocol (the contract everything hangs on)

The LLM returns a single JSON object: `{ chatMessage?: string, actions: Action[] }`. `chatMessage` is optional and the system prompt instructs the model to use it sparingly (not for routine scroll/menu/uncontroversial-edit actions). Every action is validated with Zod before anything is applied; a validation failure is surfaced, not swallowed.

Action types (initial set, extensible):

**Editing**
- `edit_text` -- `{ edits: Array<{ find: string, replace: string, occurrence?: number }> }`. Anchored find/replace against the current document text (the same reliable primitive Claude's own file editor uses). The model always sees the current text, so anchors are stable. Produces one new Version.
- `insert_text` -- `{ position: 'start' | 'end' | { afterFind: string }, text: string }`.
- `restore_version` -- `{ versionId }` (full restore) or `restore_fragment` -- `{ versionId, find, replace }` (partial restore of a fragment from an old version).
- `undo` / `redo` -- `{ count? }`. Relative navigation along the undo timeline (see below); `count` supports "undo the last three actions".

**Document management**
- `new_document` -- `{ name?: string }`
- `rename_document` -- `{ name }`
- `load_document` -- `{ documentId?, byName?, byDate? }` (opens a document; listing the documents is `open_dialog{dialog:'load'}`)

**Navigation / UI**
- `scroll` -- `{ target: 'document' | 'chat' | 'active', direction: 'up' | 'down', amount: 'line' | 'page' }`
- `open_dialog` -- `{ dialog: 'menu' | 'help' | 'load' | 'history', sort? }`. The single way to open any dialog (including edit history and the document list); `sort` is only meaningful for `load` and persists. Deliberately one action per dialog, not a generic opener plus per-dialog aliases, to keep the command-interpretation surface small.
- `close_dialog`
- `set_panel` -- `{ panel: 'chat' | 'document' }` (mobile toggle)
- `copy_document` -- copies the full document to the clipboard; the edge writes both a plaintext and a rendered-HTML flavor (from TASKS.md).
- `download_document` -- `{ format: 'md' | 'docx' }`. `.md` is the raw text; `.docx` is converted server-side via `marked` (markdown -> HTML) piped into `html-to-docx` (HTML -> .docx) -- pure JS, no pandoc/system binary, cleanly formatted. Reachable from the menu and by voice.

**Research**
- `research` -- `{ queries: string[] }`. Only ever emitted when the user explicitly asks. Triggers the multi-step backend research flow (§8), whose summary is injected back into chat context.

**Meta**
- `clarify` -- `{ question: string }`. When a command is ambiguous (e.g. "restore that paragraph" with no clear referent), the AI asks rather than guessing. Surfaced as a chat message; no state mutation.

The reducer signature: `applyAction(state, action, ctx): { state, effects, error? }`. Effects are side-effect requests (persist version, run research, focus scroll) handled at the edges -- keeping the reducer pure. `ctx` injects `newId`/`now`/`author` for determinism under test.

**Multi-action turn semantics: best-effort, not atomic (a deliberate choice).** When a turn contains several actions, each is applied independently; a failed action surfaces an error entry and threads state forward, and later independent actions still run. We chose this over atomic all-or-nothing because atomicity would discard good work -- e.g. throwing away a paragraph the user just dictated because an *unrelated* edit in the same turn had a missed anchor -- which is unacceptable for a voice user who cannot retype. The fail-explicit edit engine (ambiguous anchors throw) already limits the "silently applied to the wrong place" risk, and per-action chat entries keep partials legible. `ReduceResult.error` aggregates any failures so the edges/diagnostics can see them, and leaves the door open for an atomic policy at the edge later without changing the pure core. Pinned by tests in `reducer.test.ts`.

---

## 6. LLM integration

### Provider abstraction
```ts
interface LlmProvider {
  complete(req: {
    system: string;
    messages: ChatMessage[];
    schema: JSONSchema;      // forces structured { chatMessage?, actions[] }
    model: string;
  }): Promise<{ chatMessage?: string; actions: unknown[]; usage: Usage }>;
}
```
Default implementation targets the **OpenAI Responses API** (GPT-5.6 Luna/Terra) with JSON-schema structured output. Anthropic and OpenRouter adapters sit behind the same interface for portability. **Structured output (schema-constrained), not free-form tool calls**, because we want a deterministic, validatable envelope every turn.

### System prompt (assembled per turn)
- Role + editing philosophy: **maximally preserve the speaker's exact voice and wording; only reword when explicitly asked.**
- The full Action catalog with JSON shapes and when to use each.
- Rules for `chatMessage` frugality.
- Disambiguation rule: prefer `clarify` over guessing on destructive/ambiguous requests.

### Situational context (the user turn payload)
Assembled by the pure context assembler from AppState:
- current document name + **full current text** (with line/paragraph indices for reliable addressing),
- a **compacted summary of edit history** (not every diff -- see §12 context strategy) plus the last few raw edits,
- which dialog is open and its contents (list of documents, or the history list, or menu items),
- **scroll position and what is currently visible on screen** (visible line range),
- active panel (mobile),
- **a two-tier chat transcript, not just the recent tail.** The LLM gets (a) a rolling **`chatSummary`** -- a condensed digest of the conversation up to a checkpoint -- plus (b) every chat message **after** the checkpoint, verbatim. This ensures a standing instruction given early ("write in my terse voice") is never point-blank forgotten 30 messages later; it lives on in the summary. The edge periodically **self-summarizes**: once the number of messages since the checkpoint passes `settings.chatCompactThreshold`, it runs a summarization LLM call that folds the older messages into `chatSummary` and advances the checkpoint (`chatSummarizedCount`). The core stores both fields and the context assembler emits them; the summarization call itself lives at the edge. This is distinct from the edit-history summary (which digests document *versions*).

### Dictation vs command
Continuous listening means the model receives everything the user says. The system prompt frames every transcript as a **command to interpret**, where "insert this text" is itself one kind of command. The model decides: is this dictation to insert, an edit instruction, a navigation command, or chit-chat? This is the crux UX risk (see Risks) and needs prompt iteration + eval cases.

---

## 7. Voice / STT pipeline

### Provider interface
```ts
interface SttProvider {
  start(): void; stop(): void;
  onInterim(cb: (text: string) => void): void;   // live partial transcript
  onFinal(cb: (text: string) => void): void;      // endpointed utterance
  onVad(cb: (speaking: boolean) => void): void;    // for the pulse indicator
}
```

### Default: OpenAI Realtime streaming transcription
Browser captures mic audio (`getUserMedia` + `MediaRecorder`/AudioWorklet) and streams it over a **backend WebSocket** to OpenAI's Realtime transcription (`gpt-realtime-whisper`, with a `minimal|low|medium|high|xhigh` latency/accuracy knob). We proxy through the backend so the API key never touches the browser and so behavior is identical across desktop Chrome/Safari and iOS Chrome/Safari -- the deciding factor, since Web Speech is unreliable on WebKit/iOS. Interim + final transcripts stream back to drive the indicators. STT audio-seconds are recorded per turn for the spend meter.

### Fallback / later: pluggable engines
- **Web Speech API** -- optional zero-cost path on desktop Chrome only (its endpointing/interim behavior maps onto our indicators). Not usable as the cross-device default because of iOS/WebKit gaps.
- **Local in-browser** (Whisper via `transformers.js` WASM, or Parakeet): private/offline but heavier; in-browser Parakeet specifically is not a quick win. Revisit only if privacy/offline becomes a hard requirement. **(to verify)**

### Listening state machine + indicators
States: `idle -> listening (pulsing on VAD) -> finalizing (radial progress during STT + pre-send grace window) -> sending (spinner in chat) -> idle`.
- **Pulse** at the bottom of the chat sidebar reacts to VAD (`onVad`), showing audio is being captured.
- On silence, a **radial progress bar** runs during (a) STT finalization and (b) a short pre-send grace window during which resumed speech cancels the send ("optimistic STT"). Barge-in cancels cleanly.
- Endpointing: the Realtime API's server-side turn detection (semantic/silence VAD) signals end-of-utterance, tuned by a configurable silence threshold. A client-side VAD (Silero WASM, e.g. `@ricky0123/vad-web`) additionally drives the pulse indicator immediately without waiting on the network, and gates when we open the audio stream (so we don't stream/charge for pure silence).

### Auditory feedback (SFX)
Because he's watching the document, not the indicator, sound carries the state changes:
- **Send** -- a short beep / slot-click the instant end-of-speech is detected and the transcript is dispatched to the LLM. Confirms "I heard you and I'm working on it," so he isn't left wondering.
- **State changes** -- distinct tones for soft-mute, hard-mute, and unmute; unmute (listening re-activated) gets a brighter, rising beep / xylophone note so "you're live again" is unmistakable vs "you're muted." Muting gets a lower/falling tone.
- Short, non-intrusive, and behind a volume/mute-SFX setting. Preloaded audio buffers so there's no playback lag.

### Enabling the mic (the first-interaction gate)
Browsers require a user gesture before `getUserMedia`, so the app opens on a **full-screen "Tap to start listening" gate** (big centered button). One tap/click grants mic permission and starts continuous listening; from then on the mic never stops while the tab is foregrounded. This gate is the single required physical interaction.

### Backgrounding / multi-tab
Via the Page Visibility API, when the tab is backgrounded or the user switches away we **stop the mic** (release capture, pause the wake-word spotter); on refocus we **resume automatically**. Because the origin already holds mic permission for the session, resuming needs no fresh tap -- this is standard, non-suspicious behavior browsers permit (unlike trying to *acquire* the mic in the background, which they block). Only the foregrounded tab listens, so multi-device / multi-tab never double-captures.

### Three listening states (stop / pause / mute)
1. **Listening (default):** continuous capture, streaming speech to STT, acting on it.
2. **Paused (soft stop -- hands-free resume):** we stop streaming to cloud STT and stop acting (no cost, nothing leaves the device), but keep a local **Vosk wake-word** spotter running (open-source, keyless, on-device). Saying the wake phrase **"Yammer, wake up"** resumes full listening -- no click needed. This is the default target state for "stop listening," because it preserves hands-free operation.
3. **Muted (hard stop):** the mic track is fully released. Restarting requires a physical tap (browser gesture rule) -- used only when the user genuinely wants the mic off.

The mic button reflects state: live/pulsing when listening, gray with an "idle" indicator when paused/muted. Clicking it toggles.

### Stopping is AI-interpreted, but must be an explicit intent
Stopping never requires an exact memorized phrase -- whatever the user says goes to the LLM, which infers intent: "stop listening," "stop recording," "Yammer, pause the mic," "hold on, I'm talking to my wife" all resolve to a `set_listening: 'paused'` action. But the system prompt requires the intent to be **explicit and unambiguous**: a bare "stop" mid-sentence, or the word appearing inside dictated content, must **not** pause. The bar is "did he clearly signal he wants the mic to disregard him," not "did he say a keyword." This deliberately errs cautious (false-negative over false-positive), because the wake phrase makes recovery instant if he does get ignored, whereas a wrongful pause mid-thought is disruptive. Stop-intent cases go in the golden eval set.

### Restart-from-pause is the one fixed phrase (and that's inherent)
Resuming from **paused** is the sole asymmetry: while paused we send nothing to the LLM, so we can't AI-interpret an arbitrary "okay, continue" -- something has to be listening locally for free. That something is the on-device Vosk wake-word spotter matching the phrase **"Yammer, wake up."** So: **stop = any explicit wording (LLM-interpreted); resume-from-pause = "Yammer, wake up" (local) or a click.** A hands-free wake word is entirely doable in-browser (a local WASM speech recognizer, the same local-spotter pattern Siri/Alexa use), so he is never forced back to the cursor to resume -- unless he chose full **mute**, which by definition needs a tap.

---

## 8. Web research tool

### Two integration models (and why we build our own)
- **Model-hosted `web_search` tool** (e.g. OpenAI's built-in tool in the Responses API): the model runs search + read + summarize internally. Pros: zero infra. Cons: ~$10/1k tool calls **plus** the retrieved content billed at model token rates (often a fixed ~8k-token block per call, so $0.03+/call), it's OpenAI-specific (breaks provider neutrality), and it gives us less control over your hard requirement that raw pages be **digested, not dumped** into context.
- **DIY pipeline (chosen):** we orchestrate it, exactly matching your mental model, and we control the summarize-to-notebook step. Provider-neutral and cheaper for our volume.

### The DIY flow (`research` action -> backend `/api/research`, server-side; browser CORS forces this)
1. LLM picks search phrase(s); backend runs the search API (returns titles/snippets/URLs). Thinking-status "Searching the web..." streams to chat.
2. LLM reads the result list and **chooses which 1-3 pages to read fully**. Status "Reading results...".
3. Backend fetches the full text of the chosen pages. With Tavily/Exa this content comes back from the search API itself (no separate fetch); with a raw-SERP provider we'd add an extractor (`@mozilla/readability` + `jsdom`, or Jina Reader `r.jina.ai`).
4. A dedicated summarization LLM call **digests the pages into a compact findings note** -- and only that note is appended to chat context (a message the AI writes to itself, like research notes in a notebook). Raw page text is never persisted into the growing context. This is enforced in code, not left to prompt discipline.

Multi-step and **only** invoked when the user explicitly asks -- never autonomously.

### Provider options (behind a `SearchProvider` interface)
There are many providers; the field splits into "AI-optimized (returns clean content)" vs "raw Google SERP (you extract yourself)":
- **Tavily (recommended default)** -- built for LLM agents; one call returns search + cleaned page content. Free 1,000 searches/mo, then $30/mo for 4,000 (~$0.0075 each). Covers personal use for free.
- **Exa** -- neural/semantic search for LLMs; very generous 20,000 free requests/mo, $7/1k after, content $1/1k pages.
- **Serper** -- raw Google SERP, cheapest ($0.30-$1/1k, 2,000 free/mo), but returns only SERP data so we'd fetch/extract fulltext ourselves.
- **Not recommended:** Brave (you don't want to fund them), and **DuckDuckGo has no official API** -- only scraping libraries that get rate-limited/bot-blocked, or paid third-party scrapers, so it's not a reliable production choice despite the privacy appeal.

For a single user, Tavily's or Exa's free tier means research costs **$0/mo** until real volume. All swappable via the interface.

---

## 9. Frontend architecture

- **Layout**: two panels -- chat sidebar left, document right (desktop); single panel with voice toggle on mobile (iOS-first responsive).
- **Components**: `AppShell`, `ChatSidebar` (message list + thinking status + `ListeningIndicator` + `SpendMeter` gray total at the bottom), `DocumentPanel` (CodeMirror), `Dialog` host for `menu | help | load | history`, and a "Download diagnostic log" affordance in the menu (also voice-triggerable).
- **Store (Zustand)** holds `AppState`; UI is a pure function of it. Actions from the reducer drive both editor transactions and dialog state.
- **Chat log** shows every edit and restore attributed to `user` or `ai`, plus AI chat messages and thinking statuses.
- **Recency-fading edit highlights (the STT-correction affordance).** When the AI applies an edit, the changed text animates in with a yellow highlight that fades over ~15s, so the user can see what changed and how recently (more faded = older). This makes correction natural: seeing a wrong word still glowing, he just says "no, change that to dogs, I didn't mean bark," and the AI treats it as an ordinary follow-up `edit_text` on the freshest change. No special "correction mode" -- corrections are just the next edit, which the append-only history already handles. Fade timing is a setting.
- Full mouse/keyboard operability for every control (accessibility + dev).

---

## 10. Testing strategy

Designed so **as much as possible is unit-tested** (your explicit requirement), enabled by the pure-core architecture.

- **Unit (Vitest), the bulk:**
  - Edit engine: apply `edit_text`/`insert_text`, version creation, diff computation, idempotence, failure on non-matching anchors.
  - Action reducer: every action type -> expected state + effects; invalid actions rejected.
  - History: restore full + fragment; append-only invariant; partial restore correctness.
  - Context assembler: given an AppState, the emitted context payload is correct (visible range, open dialog, compacted history).
  - Schema validation: malformed LLM output rejected with clear errors.
  - LLM/STT providers tested against a **mock provider** with canned structured responses -- no real API calls, no spend.
- **Integration (Vitest):** server handlers (`/api/turn`, `/api/research`, CRUD) against a real ephemeral Postgres (Testcontainers or a disposable test DB) and mock LLM.
- **E2E (Playwright), mocked:** full flows with STT mocked (inject transcripts) and LLM mocked: "dictate a paragraph," "reword paragraph 3," "show edit history and restore version N," "load document by name," "scroll to top," "research X." Assert against rendered content and `qa-*` selectors (not user-visible copy). This is the default suite -- fast, free, runs on every change/CI.
- **Live-API tier (`test:live`, real spend, opt-in):** a small curated subset that exercises the real STT + real LLM against Luna, so we cover genuine model behavior (structured-output validity, edit accuracy, endpointing). Design so cost is controlled and *tracked every run*:
  - A **cost-accounting harness** wraps every provider call, sums `usage` (STT seconds x rate + tokens x per-model rate), and after the run prints a per-test and total-USD breakdown; the totals are appended to a `test-costs.jsonl` ledger so spend over time is visible.
  - A **hard per-run budget cap** (env-configurable, e.g. $0.25): the harness aborts the live suite if projected/accumulated cost exceeds it, so a runaway loop can't rack up a bill.
  - Kept **small and stable** (a handful of representative flows), gated behind an explicit script + env flag so it never runs by accident in CI or on a normal `pnpm test`. Per your global spending rule, this is the only test path that touches the real-dollar budget, and it announces its cost.
- A **golden-transcript eval set** for command-interpretation (dictation vs command vs edit vs stop-intent) overlaps with the live tier -- same accounting + cap apply.

---

## 11. Answers to your open questions

**Name.** Decided: **Yammer**. (Heads-up noted separately: "Yammer" was Microsoft's now-retired enterprise social network / Viva Engage -- irrelevant for a personal app, but a trademark shadow if you ever want a matching public domain.) The repo directory is still `yadda`; renaming it is optional and cosmetic.

**STT local vs API.** Because you're targeting iOS Safari/Chrome (both WebKit, where Web Speech is unreliable), the cross-device default is **OpenAI Realtime streaming transcription (`gpt-realtime-whisper`)** proxied through our backend WebSocket -- true streaming, a latency/accuracy knob, and identical behavior on all four browser targets. Web Speech stays as an optional desktop-Chrome-only zero-cost fallback. Local in-browser Parakeet is not a quick win; browser-local Whisper is feasible but heavier -- both stay behind the `SttProvider` interface for later. Streaming preference is fully satisfied.

**Endpointing (when to trigger STT).** Use the Realtime API's server-side turn detection for end-of-utterance, tuned by a configurable silence threshold, plus your "optimistic STT" grace window where resumed speech cancels the pending send. A client-side Silero VAD (WASM) drives the pulse indicator instantly and gates the audio stream so we don't stream/charge for silence. Visual states exactly as you described: pulse on VAD while capturing, radial progress during finalization + pre-send window.

**Combined audio+text model vs pluggable.** I agree with your instinct: **keep STT and the LLM separate and pluggable.** Swappability of cheap/powerful text models and STT engines is worth more than the latency saved by a single audio-in model, and it keeps the testable core provider-agnostic. Revisit only if end-to-end latency proves to be the dominant complaint.

**Context limits.** Your plan is right: periodically **compact old chat/edit history into a summary block**, keep the last few raw edits verbatim, and always include the full current document text (a 50-page doc is only ~30k tokens). We'll make the compaction threshold a setting. No fancier memory system needed for v1.

**Model choice (researched July 2026).** Decision: **GPT-5.6 Luna in dev, GPT-5.6 Terra in prod**, both via OpenAI direct, behind a provider abstraction. Your hypothesis holds up. Pricing per 1M tokens (input/output): Luna $1/$6, Terra $2.50/$15, Sol $5/$30, Kimi K2.5 $0.60/$2.50, DeepSeek V4 Flash $0.14/$0.28, Sonnet 5 $2/$10 (intro, then $3/$15), Haiku 4.5 $1/$5.

Rationale:
- **Dev/prod parity is the real win**, not cost. Luna and Terra are the same GPT-5.6 generation, same Responses API with programmatic tool calling, same structured-output semantics -- so the prompt behaves consistently and we debug one model family, not two. Luna reliably returns strict parseable JSON (confirmed in testing writeups), which is exactly what the Action protocol demands.
- **Cost is a non-issue in dev** for a single user (pennies per session), so DeepSeek's ~7x cheaper input isn't worth breaking parity. We keep the provider seam so we can drop to DeepSeek/Kimi if volume ever makes cost matter.
- **Our usage pattern is input-heavy, output-light** (full document in each turn, small Action JSON out), so input price + prompt caching dominate. GPT-5.6's 90% cached-input discount makes the mostly-stable document context cheap to resend each turn.
- **Caveat to watch:** Luna's long-context recall is weak (41.3% vs Terra's 89.6%). Our per-turn payload (~30k tokens for 50 pages) is short-context territory where Luna is fine, but for genuinely large documents Luna's accuracy at pinpointing a paragraph for find/replace may degrade. We'll add a large-document edit-accuracy eval before trusting Luna there; Terra covers prod regardless. Sonnet 5 is the natural prod alternative if we ever want Anthropic-grade writing -- the abstraction makes that a config flip.

---

## 12. My open questions / decisions needed before it's safe to build

**All major decisions are now resolved -- nothing blocks the build.** For the record:

- Hosted multi-user web app + Google auth + Postgres, multi-device sync (§4).
- Keys available: OpenAI / Anthropic / OpenRouter.
- Devices: desktop Chrome/Safari + iOS Chrome/Safari (mobile first-class).
- Models: **Luna dev / Terra prod**, no auto-failover for now -- single-family for parity, revisit Sonnet / Claude 5 Haiku later (§11).
- STT: **`gpt-realtime-whisper` streaming** -- latency prioritized, cost is a non-concern (§7).
- Mic UX: tap-to-start gate; listen/pause/mute; local **"Yammer, wake up"** wake-word resume (Vosk / `vosk-browser`, open-source + keyless); **explicit, cautious** AI-interpreted stop; pause-on-background/resume-on-foreground; send + mute/unmute SFX (§7).
- Correction: fading edit highlights, corrections-as-next-edit (§9).
- Destructive actions: append-only history + spoken undo, no confirmation (§4).
- Research: DIY pipeline, **Tavily**, summarize-to-notebook (§8).
- Hosting: Racknerd VPS + Caddy + a new DB on the existing Postgres (§15).
- Testing: mocked default suite + opt-in live-API tier with per-run cost accounting and a hard budget cap (§10).

**Residual small choices, all deferrable (none block Phases 0-3):** exact SFX sound design; the concrete Caddyfile/port mapping (settled at deploy time against your existing setup); whether to rename the repo directory from `yadda` to `yammer` (cosmetic). Longest-lived *risk* to keep watching is command-vs-dictation ambiguity (§14), which the golden eval set exists to catch.

---

## 13. Phased delivery roadmap

Each phase ends green (tests pass) and demoable.

- **Phase 0 -- Scaffold.** pnpm monorepo, TS config, Vite React app, Hono server, Vitest + Playwright, Tailwind, Postgres+Drizzle+migrations, Google OAuth + session, CI script. Empty two-panel shell renders behind login.
- **Phase 1 -- Core domain (pure, no UI).** AppState types, Action types + Zod schema, edit engine, version/history model, action reducer, context assembler. Heavy unit tests. **This is where most of the value and most of the tests live.**
- **Phase 2 -- LLM turn loop.** `LlmProvider` + OpenAI/GPT-5.6 adapter (Luna) + mock provider, system prompt, `/api/turn`, structured-output validation, `Turn` persistence + usage capture. Drive the reducer from a mocked model end to end in tests.
- **Phase 3 -- Frontend wiring.** CodeMirror document panel, chat sidebar, dialogs (menu/help/load/history), Zustand store, theme (system/light/dark), apply actions to real UI. Full mouse/keyboard operability. Playwright flows with mocked STT+LLM.
- **Phase 4 -- Voice.** `SttProvider` + `gpt-realtime-whisper` WS proxy, tap-to-start gate, listen/pause/mute state machine, Vosk wake-word resume, pulse + radial indicators, optimistic-send grace window, AI-interpreted stop. The first real "talk to it" build.
- **Phase 5 -- Research.** `/api/research` search (Tavily) + read + summarize-to-notebook, thinking-status streaming, `research` action.
- **Phase 6 -- Polish + hardening.** STT-correction UX, spend meter, downloadable diagnostic log, accessibility pass, prompt-eval golden set, real-model tuning (incl. large-doc edit-accuracy eval for Luna), error surfacing, settings screen.
- **Phase 7 -- Comprehensive multi-agent audit (do once the app is feature-complete).** A series of thorough fan-out, multi-agent scans for remaining issues -- the parallel reviews during the build repeatedly surfaced real reliability and security problems, so make this a deliberate, budgeted pass rather than an afterthought. Fan out independent agents per dimension, then **adversarially verify** each finding (a second agent tries to refute it) before it makes the fix list, and prioritize by user impact. Dimensions to cover:
  - **Reliability:** every hardware/network seam (mic, STT socket, DB), error handling and surfacing (no silent failures), durability and the append-only invariants, retry/reconnect/timeout coverage, concurrency and races. This is the charter's "never lose the writing / never a silent dead mic" surface.
  - **Security:** authn/authz and per-user isolation, input validation at every boundary, injection/XSS, secret handling, the WS/`/api` edge (Origin, pre-auth DoS, rate limiting), and per-user/cumulative spend ceilings.
  - **Code smell / simplification:** duplication, dead code, over-abstraction, inconsistent patterns, test titles that under-deliver on their promise.
  - **Architecture:** module boundaries and coupling, the pure-core/effects discipline, contract integrity (shared types vs runtime schemas), and whether the client-authoritative split still holds cleanly.
  Clear the resulting backlog (this §16 list plus whatever the audit adds) before considering v1 done. Re-run periodically after major changes.

---

## 14. Risks & mitigations

- **Command vs dictation ambiguity** (highest risk). Mitigate with a carefully iterated system prompt, a `clarify` action, and a golden-transcript eval set. Consider an explicit but optional spoken mode toggle ("dictation mode" vs "command mode") if pure inference proves unreliable.
- **STT accuracy for an impaired voice.** ALS can affect speech clarity over time. Mitigate with a swappable STT layer, a robust by-voice correction loop, and (later) the option of a model fine-tuned/adapted to the user's voice.
- **Latency.** Optimistic STT + fast dev model + streaming thinking-status keep it feeling responsive; measure end-to-end and revisit the single-audio-model question only if latency dominates.
- **Always-on mic privacy.** Clear listening indicator, spoken mute, and (if needed) local STT so audio never leaves the device.
- **Model drift / prompt regressions.** The eval set + structured-output validation catch breakage when we swap models.
- **Runaway API spend in tests/loops.** The live-test cost harness + hard budget cap (§10) and the per-document spend meter (§4) keep real-dollar cost visible and bounded.
- **Wake-word false triggers / stop-intent misfires.** Distinct multi-syllable wake phrase, cautious stop inference, and instant wake-word recovery so any misfire is cheap to undo.

---

## 15. Hosting & deployment

Deployed to an existing **Racknerd VPS** (ultra-budget), alongside other apps, fronted by **Caddy** as the reverse proxy (host-based routing on a shared IP, automatic TLS). This app is just another Node process: the Hono server serves the built React assets and the API, including the WebSocket STT proxy -- Caddy proxies WebSockets transparently, so no special infra. **No Fly/Render/Vercel.**

- **Database:** reuse the VPS's existing Postgres server; create a **new database** for this app with its own tables/migrations. No managed DB service.
- **Secrets:** API keys (OpenAI, Tavily, Google OAuth client) live in server-side env on the VPS, never in the browser bundle.
- **Deploy:** a lightweight script (you'll share your existing pattern from the other apps when we get there). Deployment is explicitly **later** -- not part of the initial build. Design keeps it a plain `node`-runnable server so it drops onto the box with minimal ceremony.
- **Process/ports:** app listens on a local port; Caddy maps the public hostname to it. (Details TBD against your existing Caddyfile.)

---

## 16. Security & hardening backlog (deferred, by phase)

From the multi-agent code review. The durability/correctness/cheap-safety items were fixed immediately (client persistence retry+reconcile, turn serialization, effect error surfacing, mic-freeze guard, applyInsert ambiguity, restore_fragment provenance, undo guards, diff OOM cap, UNIQUE(doc,seq) + FKs, research fan-out cap, body-size limit, repos 0-row guard, duplicate-name uniqueness). The following are deliberately deferred to the phase where they become testable end-to-end -- recorded here so they are not forgotten.

### In-browser verification checklist (first testing session)

These paths are covered by unit tests through their interfaces (fakes/mocks), but their real hardware/network behavior can only be confirmed in a real browser with keys. Work through this list during testing; anything that misbehaves is a fast fix.

- **Auth:** Google sign-in redirect completes on `localhost:5173` (redirect URI registered).
- **Mic gate:** tap-to-start requests permission; granting enters "listening"; denial surfaces an error and stays gated.
- **Real STT loop:** speech streams over the WS to OpenAI and interim/final transcripts arrive; a spoken command applies edits and persists.
- **Vosk wake word:** the model actually LOADS on first pause (watch the console -- a model-not-found error means the tar layout is wrong; fix is `tar -czf … -C "$TMP/$MODEL" .` for archive-root files), and **"Yammer, wake up"** resumes from pause.
- **iOS Safari (stated target):** `AudioContext` resumes inside the tap gesture -- capture is not silent and the first SFX plays.
- **VAD + indicators:** the pulse reacts to speech; silence triggers finalize (radial); optimistic-send cancels on resumed speech.
- **SFX:** send beep + distinct mute/unmute tones are audible.
- **Reconnect:** a dropped STT socket surfaces a visible error and auto-reconnects (hard to trigger deliberately -- kill the server mid-session).
- **Real backend features:** research (Tavily), export `.md`/`.docx`, and the diagnostic-log download all work against the live server + Postgres.
- **Voice-restore:** "restore version 3" / "go back to the first version" resolve and restore; "read the earlier version, then put that paragraph back" works as a two-step.

### Follow-ups from the second browser test (STT endpointing + UI feedback)

- **STT finalize -- FIXED (client-driven commit).** The upstream never emitted a final because we VAD-gate audio (silence is never streamed), so OpenAI's server-side VAD had no trailing silence to endpoint on -- it held the buffer forever and the client's finalize-timeout tripped ("Speech recognition did not finish"). Fix: **disable server VAD** (`turn_detection: null` in the session) and have the client **explicitly commit on VAD end-of-speech** -- a new `commit` control message (`packages/shared/src/stt.ts`) → bridge → `input_audio_buffer.commit` upstream, which forces transcription + a `...transcription.completed` (final). The commit is guarded to skip sub-120ms buffers OpenAI would reject. This supersedes the plan's earlier "use server-side turn detection" note (§7): client-driven commit preserves the cost-saving VAD gate instead of streaming silence. Diagnostics: `YAMMER_STT_DEBUG=1` (server) logs the session config + every upstream event; `VITE_VOSK_DEBUG=1` (web) logs each wake-word final with confidences.
- **Wake word -- retuned.** Switched the false-wake filter from every-word ≥ threshold (brittle -- one mumbled word blocked a real wake) to **mean** per-word confidence ≥ `VITE_VOSK_MIN_CONFIDENCE` (default 0.4). The Vosk model + grammar load fine (confirmed in console); calibration continues in-browser via `VITE_VOSK_DEBUG`.
- **Mic amplitude feedback -- DONE.** `BrowserMicCapture` computes a smoothed RMS level (fast attack / slow release, ~30/s) → `store.micLevel` → the mic button scales + brightens with the user's voice while listening, resting at normal size on silence.
- **Chat entry animation -- DONE.** New chat entries grow from height 0 to natural height over 300ms (grid-rows `0fr→1fr`; `.qa-chat-anim`), respecting `prefers-reduced-motion`.

### Follow-ups from the first browser test

- **Single process serving web + API -- DONE.** `pnpm dev` runs one process on one port (:3141): Hono serves the API + `/api/stt` WebSocket, and the web client is served by the same process (Vite middleware + HMR in dev, static bundle in prod). Same origin, no proxy, no `VITE_API_BASE`; OAuth redirect is just `:3141`. Verified by curl (client HTML on `/`, 401 on `/api/me`, SPA route 200). The real backend is now the default; `VITE_MOCK=1` selects the backend-less demo.
- **VAD assets from CDN -> self-host:** the Silero VAD worklet/model + onnxruntime WASM currently load from a pinned jsDelivr CDN (to sidestep Vite's dep-optimizer choking on the ort WASM). Copy them into `public/` for a fully self-hosted/offline build, matching the keyless-Vosk ethos.
- **Verify the two-tap gate is gone** after the VAD fix (the queued early-tap should now resolve in-gesture) and that the Vosk model actually loads in the browser.

**Voice phase -- STT bridge hardening: DONE.** Auth gate before opening upstream, max-duration / idle / byte-budget / oversized-frame / per-user-concurrency caps, and buffer-until-open are implemented and unit-tested against a fake upstream (`apps/server/src/stt/bridge.ts`, env knobs in `.env.example`). Remaining small follow-ups for the live STT tuning (in-browser, with a key):
- `stop` currently `closeBoth("done")` immediately, which can drop a trailing final transcript. Flush/commit the last utterance before closing once real endpointing is wired.
- The frozen `SttCloseReason` enum has no concurrency value, so an over-cap socket closes with `server_error`. Consider adding a dedicated reason (e.g. `too_many_sessions`) so the client can show a precise message.
- Real end-to-end (actual OpenAI realtime socket in `upstream.ts` + the socket path in `upgrade.ts`) is untested by design -- verify in the opt-in live tier / a browser once keys are set.

**Voice / correction-UX polish phase:**
- Apply the reducer's actual per-edit ranges as discrete fading highlights (the current single-span diff over-highlights multi-region edits and collapses pure deletions to zero-width).
- **Accessibility -- core pass DONE, keep extending.** Dialog focus-trap + focus-restore + `aria-modal`, `role="status"`/`aria-live` on status and error entries, and roles/labels on chat/document/indicator are implemented. Remaining: broader keyboard-shortcut coverage and a full screen-reader walkthrough.
- **Mic stream sharing:** the main capture and the Silero VAD currently open two separate `getUserMedia` streams during listening; share one `MediaStream` between them (TODO in `mic-capture.ts`).
- **Voice error surfacing -- DONE.** `WsSttClient`/mic/reconnect errors now route through the store's `pushVoiceError` into the chat error log with `aria-live` announcement (no longer just `console.error`).
- **Wake-word footprint (Vosk is a stopgap, not ideal).** We chose Vosk (`vosk-browser`) for the wake word because it is open-source and keyless, but its ~40MB model download and general-ASR CPU cost are heavier than we'd like for a task as small as spotting one phrase. Ideally replace it with a **tiny, purpose-built, open-source keyword spotter** (Porcupine-class footprint without the key). Candidates to evaluate: **openWakeWord** (ONNX, custom-trainable, ~few-MB models; browser via `onnxruntime-web`) or a transfer-trained **TensorFlow.js `speech-commands`** model for "Yammer, wake up". Both need a small training/wiring effort, hence deferred; the `WakeWordDetector` interface makes the swap a drop-in.

**Deploy-hardening phase (when the server goes live with real keys):**
- Per-user rate limiting + a per-user/daily **spend ceiling** checked (sum `turns.usage`) before each external call. The spend meter is display-only today.
- Session revocation: sessions are currently a stateless HMAC of `{uid,iat}` valid the full expiry regardless of logout. Add a `sessionVersion` in the user row (or a sessions table) so logout/compromise can revoke; consider a shorter expiry. Relevant for caregiver/shared-device use.
- Consider a DB trigger/role denying `UPDATE`/`DELETE` on the append-only `versions`/`turns` tables (FKs added now cover referential integrity).
- **WS `/api/stt` edge hardening:** an Origin allowlist on the upgrade (needs the prod domain), reject unauthenticated sockets before the full handshake + DB lookup (pre-auth DoS surface), and rate-limit upgrades. Plus a rolling **per-user cumulative STT spend ceiling** (today only per-session caps exist, so a looping authenticated client could sustain ongoing cost).
- **Single shared mic MediaStream:** the mute-releases-mic privacy fix is done, but capture + VAD (+ Vosk while paused) still open separate `getUserMedia` streams during listening; share one stream. Minor edge: rapid pause->resume can briefly orphan a Vosk stream; pre-ready prebuffer streams a little leading silence (bounded).

**Fixed (was a known correctness gap):** voice-restore now works -- `restore_version`/`restore_fragment` reference the version **seq** (resolved in the reducer), the full version list is surfaced in context so the model can reason about which to restore, and **`read_version { seq }`** loads an older version's full text into context so the model can patch a fragment from it (the vision's "read an older version into context" tool). Follow-up: the live-eval `restore_fragment` case is single-turn and may now (correctly) register the model choosing `read_version` first; tune that case for the two-step flow on the next live run.

**Voice-reachability -- audited, complete.** Every UI action maps to an Action the LLM can emit (all menu items, load-by-name, restore-by-seq, sort, close, panel toggle, scroll, listening control) and is documented in the system prompt. Settings are now voice-first too via **`update_settings`** ("switch to dark mode" / "turn off sound effects"), routed through the reducer for both voice and the settings dialog. The only inherent non-voice interactions are browser-mandated gestures: the initial tap-to-start (mic permission) and unmuting from a *hard* mute (mic fully released). Non-gap noted: scrolling a long load/history *list* by voice isn't wired, but it's a visual nicety only -- you never need to scroll to act, since you address any item by name/seq; a future `scroll` resolving to the open dialog would add it.

**Accepted tradeoff (documented, not a bug):**
- With the client-authoritative design, `/api/documents/:id/versions` trusts client-supplied version *content* (`fullText`, `author`, `kind`, `diff`). The server guarantees only monotonic seq + ownership + referential integrity, not that a version is a genuine reducer output. Acceptable for a single-user tool; revisit if the trust model ever changes.
