import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Let esbuild pre-bundle @ricky0123/vad-web AND onnxruntime-web together:
  // excluding vad-web breaks its `MicVAD` named export, and excluding
  // onnxruntime-web leaves vad-web's `require("onnxruntime-web/wasm")` as an
  // unsupported dynamic require. The ort WASM binaries themselves load at runtime
  // from a pinned CDN (onnxWASMBasePath in vad.ts), not from Vite's dep bundle.
  // No dev server / proxy here: the app is served by the single-process server
  // (apps/server) in dev (Vite middleware mode) and prod (static), same origin.
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
