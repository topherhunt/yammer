import { useAppStore, useStoreApi } from "../store/context";

// The first-interaction gate. Browsers require a user gesture before
// getUserMedia, so the app opens on a full-screen "Tap to start listening"
// button; one tap grants the mic and starts continuous listening. This is the
// single required physical interaction -- from here on the mic is voice-driven.
//
// Shown until the mic is granted. It is skipped when listening is already active
// (e.g. tests that boot straight into a listening session).

export function TapToStartGate() {
  const api = useStoreApi();
  const micStarted = useAppStore((s) => s.micStarted);
  const listening = useAppStore((s) => s.app.listening);
  // An early tap (before the late-bound voice pipeline is ready) is queued, not
  // lost; reflect that as a busy state so the button reads "Starting…".
  const startQueued = useAppStore((s) => s.startQueued);

  if (micStarted || listening === "listening") return null;

  return (
    // A labeled modal dialog: it owns the screen until the mic is granted, so
    // assistive tech announces it and traps focus on the one required control.
    <div
      className="qa-tap-gate fixed inset-0 z-50 grid place-items-center bg-white/95 backdrop-blur-sm dark:bg-gray-950/95"
      role="dialog"
      aria-modal="true"
      aria-label="Start listening"
    >
      <button
        type="button"
        // The click IS the user gesture; startMic unlocks audio + requests the mic
        // synchronously (before any await) so it stays gesture-allowed. If the
        // voice pipeline is not ready yet the tap is queued and runs on ready.
        onClick={() => api.getState().startMic()}
        // Focus the sole control on mount so a keyboard/AT user can start at once.
        autoFocus
        aria-busy={startQueued}
        className="qa-tap-gate-button flex flex-col items-center gap-4 rounded-2xl px-10 py-8 text-center"
      >
        <span
          aria-hidden
          className="grid h-24 w-24 place-items-center rounded-full bg-red-500 text-4xl text-white shadow-lg transition-transform hover:scale-105"
        >
          ●
        </span>
        <span className="text-lg font-medium text-gray-900 dark:text-gray-100">
          {startQueued ? "Starting…" : "Tap to start listening"}
        </span>
        <span className="max-w-xs text-sm text-gray-500 dark:text-gray-400">
          Yammer will ask for microphone access, then listen continuously. Say
          "stop listening" to pause.
        </span>
      </button>
    </div>
  );
}
