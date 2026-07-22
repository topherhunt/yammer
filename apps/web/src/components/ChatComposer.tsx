import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../util/cx";
import { useAppStore, useStoreApi } from "../store/context";

// The bottom-of-sidebar composer: a real text box you can type into (Enter sends),
// that STT streams into as gray "interim" text while you speak and which auto-clears
// when the utterance is submitted as a message. The mic sits at the bottom-right;
// the listen/pause/mute status is a small line beneath. It absorbs the old
// ListeningIndicator's mic button + status (same qa-mic-button / qa-listening-state
// hooks + amplitude pulse / finalize radial), so voice and keyboard share one bar.

const LABELS: Record<string, string> = {
  listening: "Listening",
  paused: 'Paused -- say "Yammer, wake up"',
  muted: "Muted",
};

export function ChatComposer() {
  const api = useStoreApi();
  const listening = useAppStore((s) => s.app.listening);
  const vad = useAppStore((s) => s.vadActive);
  const phase = useAppStore((s) => s.sttPhase);
  const micLevel = useAppStore((s) => s.micLevel);
  const listeningPhase = useAppStore((s) => s.listeningPhase);
  const interim = useAppStore((s) => s.interimTranscript);
  const backgrounded = useAppStore((s) => s.micBackgrounded);

  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Backgrounded: the tab/window lost focus, so capture is suspended (it auto-resumes
  // on return). Show it as inactive (gray + a clear label), NOT as live "Listening".
  const isListening = listening === "listening" && !backgrounded;
  const busy = phase === "sending" || listeningPhase === "finalizing";
  const pulsing = isListening && vad;

  // When the user isn't typing, the box previews the live transcript as gray text;
  // once they type (or focus to type), it becomes their editable draft instead.
  const showInterim = !focused && draft.length === 0 && interim.length > 0;
  const value = showInterim ? interim : draft;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    api.getState().submitComposerText(text);
    setDraft("");
  };

  const toggleMic = () => {
    // Soft pause (not hard mute) so the wake word keeps a hands-free resume.
    api.getState().dispatch({
      type: "set_listening",
      state: isListening ? "paused" : "listening",
    });
  };

  // Amplitude-reactive mic size + glow while listening (rests at normal on silence).
  const micStyle = isListening
    ? {
        transform: `scale(${(1 + micLevel * 0.4).toFixed(3)})`,
        filter: `brightness(${(1 + micLevel * 0.5).toFixed(3)})`,
      }
    : undefined;

  // Auto-grow the box up to a few lines as text (typed or streamed) fills it.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [value]);

  // Keep the box scrolled to the newest streamed text.
  useEffect(() => {
    const ta = taRef.current;
    if (ta && showInterim) ta.scrollTop = ta.scrollHeight;
  }, [value, showInterim]);

  return (
    <div className="qa-composer border-t border-gray-200 px-3 py-2 dark:border-gray-800">
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          readOnly={showInterim}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Type a message, or just speak…"
          aria-label="Message"
          className={cx(
            "qa-composer-input min-h-[2.5rem] flex-1 resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100",
            showInterim && "qa-composer-interim italic text-gray-400 dark:text-gray-500",
          )}
        />
        <button
          type="button"
          onClick={toggleMic}
          aria-pressed={isListening}
          aria-label="Toggle microphone"
          style={micStyle}
          className={cx(
            "qa-mic-button btn-3d relative grid h-10 w-10 shrink-0 place-items-center rounded-full text-white",
            "transition-transform duration-75 ease-out will-change-transform",
            isListening ? "bg-red-500" : "bg-gray-400 dark:bg-gray-600",
            pulsing && "qa-mic-pulsing",
          )}
        >
          <span aria-hidden className="text-sm">
            {isListening ? "●" : "○"}
          </span>
          {busy && <span className="qa-radial" aria-label="Working" />}
        </button>
      </div>
      <div
        role="status"
        aria-live="polite"
        className="qa-listening-state mt-1 text-xs text-gray-500 dark:text-gray-400"
      >
        {busy
          ? "Working…"
          : backgrounded
            ? "Paused -- window in background (returns when you come back)"
            : LABELS[listening]}
      </div>
    </div>
  );
}
