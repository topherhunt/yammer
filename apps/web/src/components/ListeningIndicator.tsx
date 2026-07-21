import { cx } from "../util/cx";
import { useAppStore, useStoreApi } from "../store/context";

// Bottom-of-sidebar mic control + status, wired to the listening machine via the
// store. It pulses when the machine reports VAD speech and shows the radial while
// an utterance is finalizing / in the pre-send grace window (listeningPhase) or a
// turn is in flight (sttPhase "sending"). The button toggles listening <-> PAUSED
// (soft stop -- the wake word stays active, so "Yammer, wake up" resumes
// hands-free); a full hard mute (releasing the mic) is a deliberate voice command
// ("mute the microphone"). All routes flow through set_listening + the machine.

const LABELS: Record<string, string> = {
  listening: "Listening",
  paused: 'Paused -- say "Yammer, wake up"',
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
    // Soft pause (not hard mute) so the wake word keeps the resume hands-free.
    api.getState().dispatch({
      type: "set_listening",
      state: isListening ? "paused" : "listening",
    });
  };

  return (
    <div
      role="group"
      aria-label="Microphone controls"
      className="qa-listening-indicator flex items-center gap-3 px-3 py-2 border-t border-gray-200 dark:border-gray-800"
    >
      <button
        type="button"
        onClick={toggle}
        aria-pressed={isListening}
        aria-label="Toggle microphone"
        className={cx(
          "qa-mic-button btn-3d relative grid place-items-center h-10 w-10 rounded-full text-white",
          isListening ? "bg-red-500" : "bg-gray-400 dark:bg-gray-600",
          pulsing && "qa-mic-pulsing",
        )}
      >
        <span aria-hidden className="text-sm">
          {isListening ? "●" : "○"}
        </span>
        {busy && <span className="qa-radial" aria-label="Working" />}
      </button>
      <span
        role="status"
        aria-live="polite"
        className="qa-listening-state text-sm text-gray-600 dark:text-gray-300"
      >
        {busy ? "Working…" : LABELS[listening]}
      </span>
    </div>
  );
}
