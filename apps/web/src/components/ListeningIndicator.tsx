import { cx } from "../util/cx";
import { useAppStore, useStoreApi } from "../store/context";

// Bottom-of-sidebar mic control + status, wired to the listening machine via the
// store. It pulses when the machine reports VAD speech and shows the radial while
// an utterance is finalizing / in the pre-send grace window (listeningPhase) or a
// turn is in flight (sttPhase "sending"). The button toggles listening/muted so
// the whole thing is mouse+keyboard operable; voice-driven pause/mute arrives via
// set_listening actions, which flow to the same machine.

const LABELS: Record<string, string> = {
  listening: "Listening",
  paused: "Paused",
  muted: "Muted",
};

export function ListeningIndicator() {
  const api = useStoreApi();
  const listening = useAppStore((s) => s.app.listening);
  const vad = useAppStore((s) => s.vadActive);
  const phase = useAppStore((s) => s.sttPhase);

  const listeningPhase = useAppStore((s) => s.listeningPhase);
  const isListening = listening === "listening";
  const busy = phase === "sending" || listeningPhase === "finalizing";
  const pulsing = isListening && vad;

  const toggle = () => {
    api.getState().dispatch({
      type: "set_listening",
      state: isListening ? "muted" : "listening",
    });
  };

  return (
    <div className="qa-listening-indicator flex items-center gap-3 px-3 py-2 border-t border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={isListening}
        aria-label="Toggle microphone"
        className={cx(
          "qa-mic-button relative grid place-items-center h-9 w-9 rounded-full text-white transition-colors",
          isListening ? "bg-red-500" : "bg-gray-400 dark:bg-gray-600",
          pulsing && "qa-mic-pulsing",
        )}
      >
        <span aria-hidden className="text-sm">
          {isListening ? "●" : "○"}
        </span>
        {busy && <span className="qa-radial" aria-label="Working" />}
      </button>
      <span className="qa-listening-state text-sm text-gray-600 dark:text-gray-300">
        {busy ? "Working…" : LABELS[listening]}
      </span>
    </div>
  );
}
