import { defineWorkspace } from "vitest/config";

// One `pnpm test` runs every package in its CORRECT environment:
//  - the pure core, shared, providers, and the server run under node;
//  - apps/web runs under jsdom via its own vite.config (React + DOM APIs like
//    the window "online" event). Running web tests under node silently breaks
//    anything touching the DOM, so they get their own project here.
// The *.live.ts eval tier is never matched (it is not *.test.ts) and stays gated.
export default defineWorkspace([
  {
    test: {
      name: "node",
      include: ["packages/**/*.test.ts", "apps/server/**/*.test.ts"],
      environment: "node",
    },
  },
  "./apps/web/vite.config.ts",
]);
