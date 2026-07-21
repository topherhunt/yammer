import { defineConfig } from "vitest/config";

// Projects + environments are defined in vitest.workspace.ts so `pnpm test`
// runs each package under the right environment (node vs jsdom).
export default defineConfig({});
