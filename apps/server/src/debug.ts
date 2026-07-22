// Opt-in debug logging that goes to BOTH the terminal and a file, so a bug report
// doesn't require the user to copy-paste terminal output -- the agent can just read
// the file. Writing is gated by the caller (the YAMMER_*_DEBUG flags); this module
// only decides WHERE. The file is JSONL (one event per line), newest appended.
//
// Default path is the repo root (yammer-debug.log, gitignored); override with
// YAMMER_DEBUG_LOG. Best-effort: a write failure never breaks a request.

import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LOG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "yammer-debug.log",
);

/** Absolute path of the debug log currently in use (for a one-time startup note). */
export const debugLogPath = process.env.YAMMER_DEBUG_LOG ?? DEFAULT_LOG_PATH;

/**
 * Append one debug event to the terminal and the debug-log file. `category` groups
 * events ("turn", "stt"); `data` is any JSON-serializable payload (raw responses,
 * timings, wire events). Callers gate on their own debug flag before calling.
 */
export function debugLog(category: string, data: unknown): void {
  const at = new Date().toISOString();
  // Terminal: keep it readable (string payloads inline).
  // eslint-disable-next-line no-console
  console.log(
    `[${category}]`,
    typeof data === "string" ? data : JSON.stringify(data),
  );
  try {
    appendFileSync(debugLogPath, `${JSON.stringify({ at, category, data })}\n`);
  } catch {
    /* best-effort: never let logging break a request */
  }
}
