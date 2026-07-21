import { defineConfig } from "vitest/config";

// Dedicated config for the opt-in live-API tier. It matches ONLY *.live.ts, so it
// is invoked deliberately (`pnpm --filter @yammer/server eval:live`) and never by
// the default `pnpm test` (whose glob is src/**/*.test.ts). The live suites
// self-gate on YAMMER_LIVE=1 + OPENAI_API_KEY and skip -- free -- otherwise.
export default defineConfig({
  test: {
    include: ["src/**/*.live.ts"],
    environment: "node",
    // Real network calls: give a run room and never bail early, so the cost
    // report + ledger line still run after a slow or failing case.
    testTimeout: 60_000,
  },
});
