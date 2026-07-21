# Yammer

A 100% voice-driven, AI-driven text editor -- write, edit, AI-chat, and research using only your voice. Mouse and keyboard work everywhere but are never *required*. Built for a friend with ALS.

You speak -> speech becomes text -> the text plus rich situational context goes to an LLM -> the LLM returns structured **actions** (edits, navigation, chat) -> a pure reducer applies them. Every edit is recorded in append-only history.

- **Full blueprint:** [`plan.md`](./plan.md) -- architecture, decisions, roadmap, and the §16 backlog (incl. the in-browser verification checklist).
- **Working guidelines for AI agents:** [`CLAUDE.md`](./CLAUDE.md).
- **Origin/vision:** [`vision.md`](./vision.md).

## Stack

TypeScript everywhere, pnpm monorepo. React + Vite + CodeMirror 6 (web), Hono + Drizzle + PostgreSQL (server), pure-TS domain core. LLM via OpenAI GPT-5.6 (Luna dev / Terra prod); STT via OpenAI `gpt-realtime-whisper`; research via Tavily; wake word via on-device Vosk (open-source, keyless). Auth via Google OAuth.

```
packages/shared   the contract: Action/AppState types, Zod schemas, provider interfaces
packages/core     pure domain: edit engine, reducer, history, context assembler (+ tests)
packages/providers OpenAI + Tavily adapters (and mocks)
apps/server        Hono API, STT WebSocket proxy, Postgres/Drizzle, auth, live-eval harness
apps/web           React UI, CodeMirror, the voice pipeline, chat sidebar
```

## Develop / test

```sh
pnpm install
pnpm test          # unified suite (node + jsdom projects), ~330 tests
pnpm -r typecheck
```

Public legal pages render at `/privacy-policy` and `/terms-of-service`.

## Run it locally

Prereqs (already set up on this machine): a local Postgres with a `yammer_dev` database, `apps/server/.env` filled in, and the Vosk model at `apps/web/public/models/`.

From a clean checkout:

1. **Database:** `createdb yammer_dev` (and `yammer_test`), then apply the schema: `psql -d yammer_dev -f apps/server/drizzle/0000_init.sql`.
2. **Server env:** copy `apps/server/.env.example` to `apps/server/.env` and fill `DATABASE_URL`, `OPENAI_API_KEY`, `TAVILY_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`.
3. **Vosk wake-word model:** `bash scripts/fetch-vosk-model.sh` (downloads ~40 MB to `apps/web/public/models/`, gitignored).
4. **Google OAuth:** register `http://localhost:5173/auth/google/callback` as an authorized redirect URI.

Then run the two dev servers:

```sh
pnpm --filter @yammer/server dev   # API + STT WS on :3141
pnpm --filter @yammer/web dev      # web app on :5173 (proxies /api + /auth to :3141)
```

Open **http://localhost:5173**, sign in with Google, tap to start listening, and talk.

> Real STT/LLM/Tavily calls cost money; the per-document spend meter (bottom of the chat sidebar) shows live cost. See `plan.md` §16 for the in-browser verification checklist.

## Live-API eval (opt-in, real spend)

A gated suite that exercises the real model on golden instruction cases, cost-accounted and hard-capped. It **skips with no spend** unless enabled:

```sh
# needs OPENAI_API_KEY in the environment; ~$0.03-0.14 per full run on Luna
YAMMER_LIVE=1 pnpm --filter @yammer/server eval:live
```

## Deployment

Self-hosted on a VPS behind Caddy, new database on the existing Postgres. Not wired yet -- see `plan.md` §15.
