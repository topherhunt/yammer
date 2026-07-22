// Ship a client-side debug event to the server so it lands in the same file-based
// debug log the agent can read (yammer-debug.log) -- no copy-paste from the browser
// console required. Fire-and-forget and fully best-effort: a failure never affects
// the app. Only called from code paths already gated behind a debug flag (e.g. the
// wake-word spotter under VITE_VOSK_DEBUG), so it is silent in normal use.

export function reportClientDebug(category: string, data: unknown): void {
  try {
    void fetch("/api/debug", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ category, data }),
    }).catch(() => {});
  } catch {
    /* best-effort */
  }
}
