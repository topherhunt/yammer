import type { SfxSound } from "@yammer/shared";

// The listening state machine -- the pure, testable heart of the voice pipeline.
//
// It is a plain reduce function: (state, event) -> { state, commands }. It holds
// NO timers and touches NO hardware; the driver (voice-controller.ts) owns the
// grace-window timer and executes the commands against the real interfaces. This
// keeps every transition -- including the optimistic-send cancel-on-resume --
// exhaustively unit-testable with injected events.
//
// Modes (the user-visible listening state):
//   idle     -- before the tap-to-start gate; nothing captured.
//   listening-- capturing; `phase` tracks the utterance sub-state.
//   paused   -- soft stop: capture released, wake-word spotter alive.
//   muted    -- hard stop: capture and wake-word both off.
//
// Capture phases (only meaningful while mode === "listening"):
//   silent     -- capturing, no speech right now (idle pulse off).
//   speaking   -- VAD reports speech (pulse on).
//   finalizing -- speech ended; awaiting the STT final for the last segment.
//   grace      -- final buffered; a short window in which resumed speech CANCELS
//                 the pending send ("optimistic STT"). On expiry we submit.

export type ListeningMode = "idle" | "listening" | "paused" | "muted";
export type CapturePhase = "silent" | "speaking" | "finalizing" | "grace";

export interface PendingUtterance {
  text: string;
  seconds: number;
}

export interface ListeningState {
  mode: ListeningMode;
  phase: CapturePhase;
  /** True when capture was stopped because the page was backgrounded; we resume
   * automatically on refocus without a fresh tap (see HIDDEN/VISIBLE). */
  suspended: boolean;
  /** Buffered final transcript(s) awaiting the grace window. Multiple segments
   * accumulate here when the user pauses briefly then resumes within grace. */
  pending: PendingUtterance | null;
}

export type ListeningEvent =
  | { type: "START" } // tap-to-start gate granted the mic
  | { type: "PAUSE" }
  | { type: "MUTE" }
  | { type: "RESUME" } // wake word or a click while paused/muted
  | { type: "SPEECH_START" } // VAD: speech began
  | { type: "SPEECH_END" } // VAD: speech ended
  | { type: "INTERIM"; text: string } // live partial transcript
  | { type: "FINAL"; text: string; seconds: number } // endpointed STT segment
  | { type: "GRACE_ELAPSED" } // the driver's grace timer fired
  | { type: "FINALIZE_TIMEOUT" } // no STT final landed while finalizing
  | { type: "HIDDEN" } // page backgrounded
  | { type: "VISIBLE" }; // page foregrounded

export type ListeningCommand =
  | { type: "START_CAPTURE" }
  | { type: "STOP_CAPTURE" }
  | { type: "START_WAKEWORD" }
  | { type: "STOP_WAKEWORD" }
  | { type: "SCHEDULE_GRACE" }
  | { type: "CANCEL_GRACE" }
  | { type: "SCHEDULE_FINALIZE" }
  | { type: "CANCEL_FINALIZE" }
  | { type: "SUBMIT"; text: string; seconds: number }
  | { type: "NOTIFY_ERROR"; message: string }
  | { type: "PLAY_SFX"; sound: SfxSound };

/** Surfaced when the STT FINAL never lands while finalizing (e.g. a dropped
 * socket). The mic stays on -- the user can simply speak again. */
export const FINALIZE_TIMEOUT_MESSAGE =
  "Speech recognition did not finish -- the microphone is still on, please try again.";

export interface Transition {
  state: ListeningState;
  commands: ListeningCommand[];
}

export const initialListeningState: ListeningState = {
  mode: "idle",
  phase: "silent",
  suspended: false,
  pending: null,
};

/** Derived UI signals for the indicator, so the view never inspects the raw
 * machine shape. Pulse = speaking; radial = finalizing or grace. */
export function indicatorFor(state: ListeningState): {
  vad: boolean;
  finalizing: boolean;
} {
  const capturing = state.mode === "listening";
  return {
    vad: capturing && state.phase === "speaking",
    finalizing:
      capturing && (state.phase === "finalizing" || state.phase === "grace"),
  };
}

function combine(
  a: PendingUtterance | null,
  text: string,
  seconds: number,
): PendingUtterance {
  if (!a) return { text, seconds };
  const joined = text ? `${a.text} ${text}`.trim() : a.text;
  return { text: joined, seconds: a.seconds + seconds };
}

/** Enter paused/muted from any mode: capture stops, any pending send is dropped,
 * and (paused only) the wake-word spotter comes up. */
function toStopped(state: ListeningState, mode: "paused" | "muted"): Transition {
  const commands: ListeningCommand[] = [{ type: "STOP_CAPTURE" }];
  if (state.mode === "listening" && state.phase === "grace") {
    commands.push({ type: "CANCEL_GRACE" });
  }
  if (state.mode === "listening" && state.phase === "finalizing") {
    commands.push({ type: "CANCEL_FINALIZE" });
  }
  if (mode === "paused") commands.push({ type: "START_WAKEWORD" });
  else commands.push({ type: "STOP_WAKEWORD" });
  return {
    state: { mode, phase: "silent", suspended: false, pending: null },
    commands,
  };
}

export function reduceListening(
  state: ListeningState,
  event: ListeningEvent,
): Transition {
  const none: Transition = { state, commands: [] };

  switch (event.type) {
    case "START":
      if (state.mode !== "idle") return none;
      return {
        state: { mode: "listening", phase: "silent", suspended: false, pending: null },
        commands: [{ type: "START_CAPTURE" }],
      };

    case "PAUSE":
      if (state.mode === "paused") return none;
      return toStopped(state, "paused");

    case "MUTE":
      if (state.mode === "muted") return none;
      return toStopped(state, "muted");

    case "RESUME": {
      if (state.mode === "listening" || state.mode === "idle") return none;
      const commands: ListeningCommand[] = [];
      if (state.mode === "paused") commands.push({ type: "STOP_WAKEWORD" });
      commands.push({ type: "START_CAPTURE" });
      return {
        state: { mode: "listening", phase: "silent", suspended: false, pending: null },
        commands,
      };
    }

    case "SPEECH_START": {
      if (state.mode !== "listening" || state.suspended) return none;
      // Barge-in during the grace window cancels the pending send but keeps the
      // buffered text -- the user is continuing the same thought.
      if (state.phase === "grace") {
        return {
          state: { ...state, phase: "speaking" },
          commands: [{ type: "CANCEL_GRACE" }],
        };
      }
      if (state.phase === "finalizing") {
        // Resumed before the final landed: cancel the finalize timeout too.
        return {
          state: { ...state, phase: "speaking" },
          commands: [{ type: "CANCEL_FINALIZE" }],
        };
      }
      if (state.phase === "silent") {
        return { state: { ...state, phase: "speaking" }, commands: [] };
      }
      return none; // already speaking
    }

    case "SPEECH_END": {
      if (state.mode !== "listening" || state.phase !== "speaking") return none;
      // Await the STT final for this segment before starting the grace window.
      // Arm a finalize timeout so a dropped socket can't hang us here forever.
      return {
        state: { ...state, phase: "finalizing" },
        commands: [{ type: "SCHEDULE_FINALIZE" }],
      };
    }

    case "INTERIM":
      return none; // live partials do not move the machine

    case "FINAL": {
      // Late finals arriving after pause/mute must never be submitted.
      if (state.mode !== "listening" || state.suspended) return none;
      const pending = combine(state.pending, event.text, event.seconds);
      // Buffer the segment and (re)open the grace window. If speech resumed before
      // this final landed (phase === "speaking"), a subsequent SPEECH_START would
      // already have kept us capturing; scheduling grace here is corrected by the
      // next SPEECH_START's CANCEL_GRACE, so we never send mid-utterance.
      return {
        state: { ...state, phase: "grace", pending },
        commands: [{ type: "CANCEL_FINALIZE" }, { type: "SCHEDULE_GRACE" }],
      };
    }

    case "FINALIZE_TIMEOUT": {
      // The STT final never arrived (e.g. a dropped socket). Leave `finalizing`
      // to a visible retryable state instead of hanging: flush any buffered text
      // and surface the failure. The mic stays on, so the user can just re-speak.
      if (state.mode !== "listening" || state.phase !== "finalizing") return none;
      const commands: ListeningCommand[] = [];
      if (state.pending) {
        commands.push({
          type: "SUBMIT",
          text: state.pending.text,
          seconds: state.pending.seconds,
        });
      }
      commands.push({ type: "NOTIFY_ERROR", message: FINALIZE_TIMEOUT_MESSAGE });
      return { state: { ...state, phase: "silent", pending: null }, commands };
    }

    case "GRACE_ELAPSED": {
      if (state.mode !== "listening" || state.phase !== "grace" || !state.pending) {
        return none;
      }
      const { text, seconds } = state.pending;
      return {
        state: { ...state, phase: "silent", pending: null },
        commands: [
          { type: "SUBMIT", text, seconds },
          { type: "PLAY_SFX", sound: "send" },
        ],
      };
    }

    case "HIDDEN": {
      if (state.suspended) return none;
      if (state.mode === "listening") {
        const commands: ListeningCommand[] = [{ type: "STOP_CAPTURE" }];
        if (state.phase === "grace") commands.push({ type: "CANCEL_GRACE" });
        if (state.phase === "finalizing") commands.push({ type: "CANCEL_FINALIZE" });
        // An involuntary background must not discard a just-finished thought: if a
        // completed utterance is buffered, submit it rather than drop it.
        if (state.pending) {
          commands.push({
            type: "SUBMIT",
            text: state.pending.text,
            seconds: state.pending.seconds,
          });
        }
        return {
          state: { mode: "listening", phase: "silent", suspended: true, pending: null },
          commands,
        };
      }
      if (state.mode === "paused") {
        return {
          state: { ...state, suspended: true },
          commands: [{ type: "STOP_WAKEWORD" }],
        };
      }
      return none; // idle / muted: nothing running
    }

    case "VISIBLE": {
      if (!state.suspended) return none;
      if (state.mode === "listening") {
        return {
          state: { ...state, phase: "silent", suspended: false },
          commands: [{ type: "START_CAPTURE" }],
        };
      }
      if (state.mode === "paused") {
        return {
          state: { ...state, suspended: false },
          commands: [{ type: "START_WAKEWORD" }],
        };
      }
      return { state: { ...state, suspended: false }, commands: [] };
    }
  }
}
