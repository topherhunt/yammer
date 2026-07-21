import { defineConfig } from "vitest/config";

// Package-local config so `pnpm --filter @yammer/server test` discovers this
// package's tests (the root config's globs are repo-root-relative and match
// nothing when vitest runs with apps/server as its root). Running the whole suite
// from the repo root still goes through the root config.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
