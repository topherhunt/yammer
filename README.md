# Yammer

A voice-driven, AI-driven text editor: write, edit, AI-chat, and research using only your voice. Mouse and keyboard work everywhere but are never *required*. Built for a friend with ALS.

> **Status:** early and under active development. It works end to end locally, but it isn't deployed or production-hardened yet.

## How it works

You speak -> speech becomes text -> the text plus rich situational context goes to an LLM -> the LLM returns structured **actions** (edits, navigation, chat) -> a pure reducer applies them. Every edit is recorded in append-only history, so any version can be restored.

- **Voice:** streaming speech-to-text, client-side voice activity detection, and an on-device "Yammer, wake up" wake word to resume hands-free.
- **Editing:** dictation continues at your cursor; corrections are just the next thing you say. Recent edits fade from yellow so you can see what changed.
- **History:** full snapshot per version; restore and undo append new versions instead of rewriting history.
- **Research:** on request, searches the web, reads selected pages, and folds a digest into the conversation.
- **Cost visibility:** a per-document spend meter tracks speech-to-text and inference cost.

## Stack

TypeScript pnpm monorepo. React + Vite + CodeMirror 6 + Zustand + Tailwind (web), Hono + Drizzle + PostgreSQL (server), Google OAuth. LLM via OpenAI GPT-5.6, speech-to-text via OpenAI `gpt-realtime-whisper`, web search via Tavily, wake word via [Vosk](https://alphacephei.com/vosk/) running in the browser.

```
packages/shared     the contract: Action/AppState types, Zod schemas, provider interfaces
packages/core       pure domain: edit engine, reducer, history, context assembler
packages/providers  OpenAI + Tavily adapters
apps/server         Hono API, STT WebSocket proxy, Postgres/Drizzle, auth, live-eval harness
apps/web            React UI, CodeMirror editor, voice pipeline, chat sidebar
```

## Getting started

### Prerequisites

- Node 20+ and pnpm 8
- PostgreSQL
- API keys for OpenAI and Tavily
- A Google OAuth client (web application type)

### Setup

```sh
pnpm install

# Database
createdb yammer_dev
createdb yammer_test
psql -d yammer_dev -f apps/server/drizzle/0000_init.sql

# Environment: fill in DATABASE_URL, OPENAI_API_KEY, TAVILY_API_KEY,
# GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET
cp apps/server/.env.example apps/server/.env

# Vosk wake-word model (~40 MB, gitignored)
bash scripts/fetch-vosk-model.sh
```

In your Google OAuth client, add `http://localhost:3141/auth/google/callback` as an authorized redirect URI.

### Run

```sh
pnpm dev
```

One process serves the API, the STT WebSocket, and the web client at **http://localhost:3141**. Sign in with Google, tap to start listening, and talk.

To try the UI without a backend or API keys: `VITE_MOCK=1 pnpm --filter @yammer/web dev`.

Real speech-to-text, LLM, and search calls cost money; the spend meter at the bottom of the chat sidebar shows live cost.

## Testing

```sh
pnpm test        # unit + component tests (no network, no spend)
pnpm typecheck
```

An opt-in live-API eval runs golden instruction cases against the real model. It is cost-accounted, hard-capped by `YAMMER_LIVE_BUDGET_USD` (default $0.50), and skips unless enabled:

```sh
YAMMER_LIVE=1 pnpm --filter @yammer/server eval:live   # needs OPENAI_API_KEY; a few cents per run
```

## Docs

- [`plan.md`](./plan.md) -- full blueprint: architecture, decisions, roadmap, backlog
- [`vision.md`](./vision.md) -- the original vision
- [`CLAUDE.md`](./CLAUDE.md) -- working guidelines for AI coding agents

## License

[MIT](./LICENSE)
