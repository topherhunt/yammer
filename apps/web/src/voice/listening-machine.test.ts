import { describe, expect, it } from "vitest";
import {
  indicatorFor,
  initialListeningState,
  reduceListening,
} from "./listening-machine";
import type {
  ListeningCommand,
  ListeningEvent,
  ListeningState,
} from "./listening-machine";

// The listening machine is the testable heart of the voice pipeline, so every
// transition is pinned here with injected events -- no timers, no hardware.

/** Fold a sequence of events, returning the final state and the commands the
 * LAST event produced. */
function fold(
  events: ListeningEvent[],
  start: ListeningState = initialListeningState,
): { state: ListeningState; commands: ListeningCommand[] } {
  let state = start;
  let commands: ListeningCommand[] = [];
  for (const event of events) {
    const result = reduceListening(state, event);
    state = result.state;
    commands = result.commands;
  }
  return { state, commands };
}

const cmdTypes = (commands: ListeningCommand[]) => commands.map((c) => c.type);

/** Drive the machine into a live listening/silent state past the tap gate. */
const listening: ListeningState = fold([{ type: "START" }]).state;

describe("tap-to-start gate", () => {
  it("START moves idle -> listening and opens capture", () => {
    const { state, commands } = fold([{ type: "START" }]);
    expect(state.mode).toBe("listening");
    expect(state.phase).toBe("silent");
    expect(cmdTypes(commands)).toEqual(["START_CAPTURE"]);
  });

  it("ignores START once already listening", () => {
    const { state, commands } = fold([{ type: "START" }], listening);
    expect(state).toBe(listening);
    expect(commands).toEqual([]);
  });
});

describe("normal utterance -> optimistic send", () => {
  it("VAD + STT final drive silent -> speaking -> finalizing -> grace -> submit", () => {
    let state = listening;

    ({ state } = reduceListening(state, { type: "SPEECH_START" }));
    expect(state.phase).toBe("speaking");
    expect(indicatorFor(state).vad).toBe(true);

    ({ state } = reduceListening(state, { type: "SPEECH_END" }));
    expect(state.phase).toBe("finalizing");
    expect(indicatorFor(state).finalizing).toBe(true);

    let out = reduceListening(state, {
      type: "FINAL",
      text: "hello world",
      seconds: 1.5,
    });
    state = out.state;
    expect(state.phase).toBe("grace");
    expect(state.pending).toEqual({ text: "hello world", seconds: 1.5 });
    // The arrived FINAL cancels the finalize-timeout guard before opening grace.
    expect(cmdTypes(out.commands)).toEqual(["CANCEL_FINALIZE", "SCHEDULE_GRACE"]);
    expect(indicatorFor(state).finalizing).toBe(true);

    out = reduceListening(state, { type: "GRACE_ELAPSED" });
    state = out.state;
    expect(out.commands).toEqual([
      { type: "SUBMIT", text: "hello world", seconds: 1.5 },
      { type: "PLAY_SFX", sound: "send" },
    ]);
    // Back to capturing, ready for the next utterance.
    expect(state.phase).toBe("silent");
    expect(state.pending).toBeNull();
  });
});

describe("optimistic-send cancel-on-resume (barge-in)", () => {
  it("speech during the grace window cancels the send but keeps the buffered text", () => {
    const afterFinal = fold(
      [
        { type: "SPEECH_START" },
        { type: "SPEECH_END" },
        { type: "FINAL", text: "first part", seconds: 1 },
      ],
      listening,
    ).state;
    expect(afterFinal.phase).toBe("grace");

    // The user resumes within the window: cancel the pending send, stay capturing.
    const resumed = reduceListening(afterFinal, { type: "SPEECH_START" });
    expect(cmdTypes(resumed.commands)).toEqual(["CANCEL_GRACE"]);
    expect(resumed.state.phase).toBe("speaking");
    // The earlier transcript is retained, not dropped.
    expect(resumed.state.pending).toEqual({ text: "first part", seconds: 1 });

    // Second segment finalizes; the grace window reopens with BOTH segments.
    const combined = fold(
      [
        { type: "SPEECH_END" },
        { type: "FINAL", text: "second part", seconds: 2 },
      ],
      resumed.state,
    );
    expect(combined.state.pending).toEqual({
      text: "first part second part",
      seconds: 3,
    });
    expect(cmdTypes(combined.commands)).toEqual(["CANCEL_FINALIZE", "SCHEDULE_GRACE"]);

    // Now the window elapses: one combined submit for the whole thought.
    const sent = reduceListening(combined.state, { type: "GRACE_ELAPSED" });
    expect(sent.commands).toEqual([
      { type: "SUBMIT", text: "first part second part", seconds: 3 },
      { type: "PLAY_SFX", sound: "send" },
    ]);
  });

  it("resumed speech during finalizing (before the final lands) stays one utterance", () => {
    const state = fold(
      [{ type: "SPEECH_START" }, { type: "SPEECH_END" }],
      listening,
    ).state;
    expect(state.phase).toBe("finalizing");
    const resumed = reduceListening(state, { type: "SPEECH_START" });
    expect(resumed.state.phase).toBe("speaking");
    // Resuming out of finalizing cancels the finalize-timeout guard.
    expect(resumed.commands).toEqual([{ type: "CANCEL_FINALIZE" }]);
  });
});

describe("pause / mute / resume", () => {
  it("PAUSE stops capture and brings up the wake-word spotter", () => {
    const out = reduceListening(listening, { type: "PAUSE" });
    expect(out.state.mode).toBe("paused");
    expect(cmdTypes(out.commands)).toEqual(["STOP_CAPTURE", "START_WAKEWORD"]);
  });

  it("PAUSE mid-grace also cancels the pending send", () => {
    const inGrace = fold(
      [
        { type: "SPEECH_START" },
        { type: "SPEECH_END" },
        { type: "FINAL", text: "x", seconds: 1 },
      ],
      listening,
    ).state;
    const out = reduceListening(inGrace, { type: "PAUSE" });
    expect(cmdTypes(out.commands)).toEqual([
      "STOP_CAPTURE",
      "CANCEL_GRACE",
      "START_WAKEWORD",
    ]);
    expect(out.state.pending).toBeNull();
  });

  it("MUTE stops capture and the wake-word spotter (hard stop)", () => {
    const out = reduceListening(listening, { type: "MUTE" });
    expect(out.state.mode).toBe("muted");
    expect(cmdTypes(out.commands)).toEqual(["STOP_CAPTURE", "STOP_WAKEWORD"]);
  });

  it("RESUME from paused stops the spotter and reopens capture", () => {
    const paused = reduceListening(listening, { type: "PAUSE" }).state;
    const out = reduceListening(paused, { type: "RESUME" });
    expect(out.state.mode).toBe("listening");
    expect(cmdTypes(out.commands)).toEqual(["STOP_WAKEWORD", "START_CAPTURE"]);
  });

  it("RESUME from muted reopens capture (no spotter was running)", () => {
    const muted = reduceListening(listening, { type: "MUTE" }).state;
    const out = reduceListening(muted, { type: "RESUME" });
    expect(out.state.mode).toBe("listening");
    expect(cmdTypes(out.commands)).toEqual(["START_CAPTURE"]);
  });

  it("ignores RESUME while already listening", () => {
    expect(reduceListening(listening, { type: "RESUME" }).commands).toEqual([]);
  });

  it("never submits a late final that lands after a pause", () => {
    const paused = reduceListening(listening, { type: "PAUSE" }).state;
    const out = reduceListening(paused, {
      type: "FINAL",
      text: "too late",
      seconds: 1,
    });
    expect(out.commands).toEqual([]);
    expect(out.state.pending).toBeNull();
  });
});

describe("background / foreground (Page Visibility)", () => {
  it("HIDDEN while listening releases capture and marks suspended", () => {
    const out = reduceListening(listening, { type: "HIDDEN" });
    expect(out.state.suspended).toBe(true);
    expect(out.state.mode).toBe("listening");
    expect(cmdTypes(out.commands)).toEqual(["STOP_CAPTURE"]);
  });

  it("VISIBLE resumes capture automatically without a fresh tap", () => {
    const hidden = reduceListening(listening, { type: "HIDDEN" }).state;
    const out = reduceListening(hidden, { type: "VISIBLE" });
    expect(out.state.suspended).toBe(false);
    expect(cmdTypes(out.commands)).toEqual(["START_CAPTURE"]);
  });

  it("suspends and resumes the wake-word spotter when paused", () => {
    const paused = reduceListening(listening, { type: "PAUSE" }).state;
    const hidden = reduceListening(paused, { type: "HIDDEN" });
    expect(cmdTypes(hidden.commands)).toEqual(["STOP_WAKEWORD"]);
    const visible = reduceListening(hidden.state, { type: "VISIBLE" });
    expect(cmdTypes(visible.commands)).toEqual(["START_WAKEWORD"]);
  });

  it("ignores VAD while suspended", () => {
    const hidden = reduceListening(listening, { type: "HIDDEN" }).state;
    expect(reduceListening(hidden, { type: "SPEECH_START" }).state.phase).toBe(
      "silent",
    );
  });

  it("HIDDEN is a no-op when muted", () => {
    const muted = reduceListening(listening, { type: "MUTE" }).state;
    expect(reduceListening(muted, { type: "HIDDEN" }).commands).toEqual([]);
  });
});

describe("indicator projection + inert events", () => {
  it("maps phases to pulse (vad) and radial (finalizing)", () => {
    expect(indicatorFor(listening)).toEqual({ vad: false, finalizing: false, suspended: false });
    const speaking = reduceListening(listening, { type: "SPEECH_START" }).state;
    expect(indicatorFor(speaking)).toEqual({ vad: true, finalizing: false, suspended: false });
    const finalizing = reduceListening(speaking, { type: "SPEECH_END" }).state;
    expect(indicatorFor(finalizing)).toEqual({ vad: false, finalizing: true, suspended: false });
    const paused = reduceListening(listening, { type: "PAUSE" }).state;
    expect(indicatorFor(paused)).toEqual({ vad: false, finalizing: false, suspended: false });
  });

  it("reports suspended (backgrounded) so the indicator can gray out", () => {
    const hidden = reduceListening(listening, { type: "HIDDEN" }).state;
    // Mode stays listening (auto-resumes), but capture is suspended -> not live.
    expect(indicatorFor(hidden)).toEqual({ vad: false, finalizing: false, suspended: true });
    const visible = reduceListening(hidden, { type: "VISIBLE" }).state;
    expect(indicatorFor(visible)).toEqual({ vad: false, finalizing: false, suspended: false });
  });

  it("INTERIM and stray GRACE_ELAPSED do nothing", () => {
    expect(
      reduceListening(listening, { type: "INTERIM", text: "typing" }).commands,
    ).toEqual([]);
    expect(
      reduceListening(listening, { type: "GRACE_ELAPSED" }).commands,
    ).toEqual([]);
  });
});
