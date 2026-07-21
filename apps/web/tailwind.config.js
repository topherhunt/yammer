import { fileURLToPath } from "node:url";
import path from "node:path";

// Absolute content globs (relative to this config file, not the process cwd) so
// Tailwind finds the source files even when Vite runs from the single-process
// server (whose cwd is apps/server). Relative globs would resolve to nothing,
// purging every utility and leaving the app unstyled.
const dir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [path.join(dir, "index.html"), path.join(dir, "src/**/*.{ts,tsx}")],
  darkMode: "class",
  theme: {
    extend: {},
  },
  plugins: [],
};
