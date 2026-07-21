import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Dev proxy to the API server (:3141). changeOrigin:false preserves the
      // Host header so the server builds the Google OAuth redirect_uri from the
      // browser origin (http://localhost:5173) -- that is the URI to register in
      // Google Console. ws:true upgrades the /api/stt WebSocket.
      "/api": { target: "http://localhost:3141", ws: true, changeOrigin: false },
      "/auth": { target: "http://localhost:3141", changeOrigin: false },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
