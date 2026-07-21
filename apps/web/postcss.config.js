import { fileURLToPath } from "node:url";
import path from "node:path";

// Point the tailwindcss plugin at the config by ABSOLUTE path. Otherwise it
// searches from the process cwd -- which is apps/server under the single-process
// server -- fails to find tailwind.config.js, falls back to an empty config, and
// generates no utilities (the "content is missing or empty" warning).
const dir = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: path.join(dir, "tailwind.config.js") },
    autoprefixer: {},
  },
};
