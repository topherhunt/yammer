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

  if (micStarted || listening === "listening") return null;

  return (
    <div className="qa-tap-gate fixed inset-0 z-50 grid place-items-center bg-white/95 backdrop-blur-sm dark:bg-gray-950/95">
      <button
        type="button"
        // The click IS the user gesture; startMic triggers the set_listening
        // effect synchronously so the mic-permission request is gesture-allowed.
        onClick={() => api.getState().startMic()}
        className="qa-tap-gate-button flex flex-col items-center gap-4 rounded-2xl px-10 py-8 text-center"
      >
        <span
          aria-hidden
          className="grid h-24 w-24 place-items-center rounded-full bg-red-500 text-4xl text-white shadow-lg transition-transform hover:scale-105"
        >
          ●
        </span>
        <span className="text-lg font-medium text-gray-900 dark:text-gray-100">
          Tap to start listening
        </span>
        <span className="max-w-xs text-sm text-gray-500 dark:text-gray-400">
          Yammer will ask for microphone access, then listen continuously. Say
          "stop listening" to pause.
        </span>
      </button>
    </div>
  );
}
