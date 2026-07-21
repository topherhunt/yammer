# PLAN: Yadda -- a 100% voice-driven, AI-driven text editor

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
| STT | **OpenAI Realtime streaming transcription (`gpt-realtime-whisper`)** over a backend WebSocket, behind an `SttProvider` interface | Reversal from an earlier Web-Speech-first lean: iOS Safari/Chrome (WebKit) make Web Speech unreliable, and you're targeting iOS. Realtime gives true streaming + a latency/accuracy knob + identical behavior on all four browser targets. Web Speech stays as an optional desktop-Chrome-only zero-cost fallback. See §7. |
| Persistence | **PostgreSQL** + Drizzle ORM + migrations | Hosted, multi-user, multi-device sync. Per-user data isolation. Append-only version/event tables fit naturally. |
| Auth | **Google OAuth** (Sign in with Google) via Auth.js/Lucia-style session | One `users` row per Google login; all documents/history scoped to `userId`. HTTP-only session cookies. |
| Tests | **Vitest** (unit/integration) + **Playwright** (E2E) | Vitest for the pure core and server handlers; Playwright for real browser + voice-mocked flows. |

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
   │  - /api/turn: build system+user prompt, call LlmProvider,        │
   │    validate structured Action[] against schema, persist Turn     │
   │  - /api/research: web search + fetch + summarize (server-side)   │
   │  - /api/documents, /api/versions, /api/settings, /api/diagnostics│
   │  - holds all API keys; nothing secret in the browser             │
   └───────────────┬─────────────────────────────────────────────────┘
                   │
      ┌────────────┴───────────┐        ┌──────────────────────────────┐
      │ PostgreSQL (users,     │        │ GPT-5.6 (Luna dev/Terra prod)│
      │ documents, versions,   │        │ + OpenAI Realtime STT        │
      │ turns, settings)       │        │ (provider abstraction)       │
      └────────────────────────┘        └──────────────────────────────┘
```

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

- **User**: `id`, `googleSub`, `email`, `name`, `createdAt`. One row per Google login.
- **Document**: `id`, `userId`, `name`, `createdAt`, `updatedAt`, `currentVersionId`.
- **Version** (append-only event): `id`, `userId`, `documentId`, `seq` (monotonic per doc), `parentVersionId`, `author` (`'user' | 'ai'`), `kind` (`'edit' | 'create' | 'restore' | 'rename'`), `summary` (human-readable, e.g. "Reworded paragraph 3"), `fullText` (the complete document text at this version), `diff` (computed unified/word diff vs parent, for display), `createdAt`, and optional `restoredFromVersionId`.
- **Turn** (append-only diagnostic + chat log): `id`, `userId`, `documentId`, `createdAt`, `transcript` (raw STT text sent), `sttMeta` (provider, audio seconds, interim-vs-final), `llmModel`, `llmRawResponse` (full JSON the model returned), `actions` (validated Action[] applied), `chatMessage`, `usage` (`{ sttSeconds, sttCost, inTokens, outTokens, cachedTokens, llmCost }`). This single table powers the chat sidebar, the spend meter, and the downloadable diagnostic log -- so those features are byproducts of data we already persist, not extra plumbing.
- **Settings** (per user): `activeDocumentId`, `loadDocSort`, `model` config, `sttProvider`, voice-tuning params (silence threshold, optimistic-send delay), UI prefs.

### Spend meter (per document)

The small gray total at the bottom of the chat sidebar is `SUM(usage)` over the document's `Turn` rows: STT audio-seconds x rate + inference tokens x rate (input/cached/output priced separately per the active model). Computed, not separately tracked. Shown as tokens + estimated USD.

### Diagnostic log download

"Download full diagnostic log" (menu click or voice) serializes this document's `Turn` rows (transcript -> raw LLM response -> resulting actions) plus the full `Version` history into a single JSON (and a human-readable rendering) file the user can email for troubleshooting. It's just a query + serialize over the append-only tables.

### Why full-text snapshots per version (the "battle-tested edit tracking" call)

Your vision worries about storing only deltas to save space while guaranteeing corruption-free replay. Those two goals are in tension: deltas save space but carry replay/merge/corruption risk; snapshots are bulletproof but bigger. For a **single-user personal app** the space cost is negligible -- a 50-page doc is ~120 KB, so even 500 revisions is ~60 MB, trivial on disk. So the right engineering call is:

- **Store the full text at every version** (bulletproof: restore = read a row, no replay).
- **Also store a computed diff** vs the parent purely for display in the history list and chat log.
- Restores and partial restores (e.g. "restore the 3rd paragraph to a few edits ago") are implemented as: read the old version's text, compute the new full text, append a new `kind: 'restore'` version. History is never mutated -- exactly your git-like requirement.

This gives us the git-like append-only semantics and the "no risk of corruption" guarantee, and it is far simpler and safer than a delta/CRDT replay engine. If disk ever matters we can add snapshot-compaction later (keep every Nth full snapshot + deltas between) without changing the public API. I recommend we **not** reach for Yjs/Automerge/ProseMirror-steps here: those shine for real-time multi-user collaboration, which we do not have.

---

## 5. The Action protocol (the contract everything hangs on)

The LLM returns a single JSON object: `{ chatMessage?: string, actions: Action[] }`. `chatMessage` is optional and the system prompt instructs the model to use it sparingly (not for routine scroll/menu/uncontroversial-edit actions). Every action is validated with Zod before anything is applied; a validation failure is surfaced, not swallowed.

Action types (initial set, extensible):

**Editing**
- `edit_text` -- `{ edits: Array<{ find: string, replace: string, occurrence?: number }> }`. Anchored find/replace against the current document text (the same reliable primitive Claude's own file editor uses). The model always sees the current text, so anchors are stable. Produces one new Version.
- `insert_text` -- `{ position: 'start' | 'end' | { afterFind: string }, text: string }`.
- `restore_version` -- `{ versionId }` (full restore) or `restore_fragment` -- `{ versionId, find, replace }` (partial restore of a fragment from an old version).

**Document management**
- `new_document` -- `{ name?: string }`
- `rename_document` -- `{ name }`
- `load_document` -- `{ documentId?, byName?, byDate? }`
- `list_documents` -- `{ sort?: 'name' | 'created' | 'updated' }`

**Navigation / UI**
- `scroll` -- `{ target: 'document' | 'chat' | 'active', direction: 'up' | 'down', amount: 'line' | 'page' }`
- `open_dialog` -- `{ dialog: 'menu' | 'help' | 'load' | 'history' }`
- `close_dialog`
- `set_panel` -- `{ panel: 'chat' | 'document' }` (mobile toggle)
- `show_edit_history`

**Research**
- `research` -- `{ queries: string[] }`. Only ever emitted when the user explicitly asks. Triggers the multi-step backend research flow (§8), whose summary is injected back into chat context.

**Meta**
- `clarify` -- `{ question: string }`. When a command is ambiguous (e.g. "restore that paragraph" with no clear referent), the AI asks rather than guessing. Surfaced as a chat message; no state mutation.

The reducer signature: `applyAction(state: AppState, action: Action): { state: AppState, effects: Effect[] }`. Effects are side-effect requests (persist version, run research, focus scroll) handled at the edges -- keeping the reducer pure.

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
Default implementation targets OpenRouter's OpenAI-compatible endpoint with JSON-schema structured output. A second adapter can target Anthropic/OpenAI natively if we want. **Structured output (schema-constrained), not free-form tool calls**, because we want a deterministic, validatable envelope every turn.

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
- the recent chat transcript.

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
- **Voice control of listening itself:** since push-to-talk is impossible (no hands), the mic is always-on by default, with spoken "stop listening" / "start listening" commands and an unmistakable on-screen listening state. (Privacy + accidental-capture handling -- see Open Questions.)

---

## 8. Web research tool

`research` action -> backend `/api/research`:
1. Run web search for each query (server-side; browser CORS makes this a must, as you noted).
2. Fetch full text of the top results.
3. Summarize into a findings block.
4. Return the summary, which is injected into chat context and shown as an AI chat message.

Multi-step and **only** invoked when the user explicitly asks -- never autonomously. Thinking-status messages ("Searching the web...", "Reading results...") stream to the chat sidebar. Search provider (Brave/Bing/Tavily/etc.) is behind a small interface. **(provider to pick)**

---

## 9. Frontend architecture

- **Layout**: two panels -- chat sidebar left, document right (desktop); single panel with voice toggle on mobile (iOS-first responsive).
- **Components**: `AppShell`, `ChatSidebar` (message list + thinking status + `ListeningIndicator` + `SpendMeter` gray total at the bottom), `DocumentPanel` (CodeMirror), `Dialog` host for `menu | help | load | history`, and a "Download diagnostic log" affordance in the menu (also voice-triggerable).
- **Store (Zustand)** holds `AppState`; UI is a pure function of it. Actions from the reducer drive both editor transactions and dialog state.
- **Chat log** shows every edit and restore attributed to `user` or `ai`, plus AI chat messages and thinking statuses.
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
- **Integration (Vitest):** server handlers (`/api/turn`, `/api/research`, CRUD) with an in-memory SQLite and mock LLM.
- **E2E (Playwright):** full flows with STT mocked (inject transcripts) and LLM mocked: "dictate a paragraph," "reword paragraph 3," "show edit history and restore version N," "load document by name," "scroll to top," "research X." Assert against rendered content and `qa-*` selectors (not user-visible copy).
- A small **golden-transcript eval set** for the command-interpretation prompt (dictation vs command vs edit), run against the cheap dev model, to catch prompt regressions. (Costs real tokens -> gated, opt-in, small N.)

---

## 11. Answers to your open questions

**Name.** "Yadda" is memorable and playful, but it leans on "yadda yadda" = *meaningless* chatter, which is slightly at odds with an app that's meant to give someone their voice back -- a touch dismissive. If that irony feels fun to you and your friend, keep it. If you want the playful-chatty vibe without the "blah blah" undertone, my shortlist: **Blurt** (you blurt, it writes -- my favorite), **Gab**, **Natter**, **Yap**, **Yammer**. I'll keep the repo named `yadda` until you decide.

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

**Resolved:** hosted multi-user web app + Google auth + Postgres, multi-device sync (§4). Keys: OpenAI/Anthropic/OpenRouter available. Devices: desktop Chrome/Safari + iOS Chrome/Safari (mobile is first-class). Models: Luna dev / Terra prod (§11). STT: OpenAI Realtime streaming (§7).

Still open, ordered by how much they change what we build:

1. **Always-on mic UX + privacy.** Push-to-talk is impossible, so the mic is always listening. How do we handle: accidental capture of side conversation, a clear "I'm listening now / I'm muted" signal, and a reliable spoken mute/unmute? Do we need any wake-word gating, or is "everything is a command, model decides" acceptable for v1? (This is the highest-risk UX decision.)
2. **STT-error correction loop.** STT will mishear, and your friend can't just retype. The by-voice correction flow ("no, I said X", "fix the last word") is central to this being usable and deserves explicit design in v1, not v2. Agree?
3. **Confirmation for destructive/irreversible actions.** Delete document, large rewrite -- do we require a spoken confirmation, or is append-only history enough of a safety net (nothing is ever truly lost)? I lean on the latter plus a spoken "undo".
4. **Research provider.** Which web-search API do you want behind `/api/research` (Brave, Tavily, Bing, etc.)? Any existing key?
5. **Hosting target.** Where does this deploy (Fly/Render/Railway/Vercel + managed Postgres like Neon/Supabase)? Affects the WebSocket-STT proxy setup and env/secrets. Any preference?
6. **Model-family switch fallback.** GPT-5.6 requires OpenAI availability; do you want Sonnet 5 pre-wired as an automatic failover in prod, or is a manual config flip fine?

---

## 13. Phased delivery roadmap

Each phase ends green (tests pass) and demoable.

- **Phase 0 -- Scaffold.** pnpm monorepo, TS config, Vite React app, Hono server, Vitest + Playwright, Tailwind, Postgres+Drizzle+migrations, Google OAuth + session, CI script. Empty two-panel shell renders behind login.
- **Phase 1 -- Core domain (pure, no UI).** AppState types, Action types + Zod schema, edit engine, version/history model, action reducer, context assembler. Heavy unit tests. **This is where most of the value and most of the tests live.**
- **Phase 2 -- LLM turn loop.** `LlmProvider` + OpenRouter adapter + mock provider, system prompt, `/api/turn`, structured-output validation. Drive the reducer from a mocked model end to end in tests.
- **Phase 3 -- Frontend wiring.** CodeMirror document panel, chat sidebar, dialogs (menu/help/load/history), Zustand store, apply actions to real UI. Full mouse/keyboard operability. Playwright flows with mocked STT+LLM.
- **Phase 4 -- Voice.** `SttProvider` + Web Speech impl, listening state machine, pulse + radial indicators, optimistic-send grace window, spoken mute/unmute. The first real "talk to it" build.
- **Phase 5 -- Research.** `/api/research` search+fetch+summarize, thinking-status streaming, `research` action.
- **Phase 6 -- Polish + hardening.** STT-correction UX, spend meter, downloadable diagnostic log, accessibility pass, prompt-eval golden set, real-model tuning (incl. large-doc edit-accuracy eval for Luna), error surfacing, settings screen.

---

## 14. Risks & mitigations

- **Command vs dictation ambiguity** (highest risk). Mitigate with a carefully iterated system prompt, a `clarify` action, and a golden-transcript eval set. Consider an explicit but optional spoken mode toggle ("dictation mode" vs "command mode") if pure inference proves unreliable.
- **STT accuracy for an impaired voice.** ALS can affect speech clarity over time. Mitigate with a swappable STT layer, a robust by-voice correction loop, and (later) the option of a model fine-tuned/adapted to the user's voice.
- **Latency.** Optimistic STT + fast dev model + streaming thinking-status keep it feeling responsive; measure end-to-end and revisit the single-audio-model question only if latency dominates.
- **Always-on mic privacy.** Clear listening indicator, spoken mute, and (if needed) local STT so audio never leaves the device.
- **Model drift / prompt regressions.** The eval set + structured-output validation catch breakage when we swap models.
```
