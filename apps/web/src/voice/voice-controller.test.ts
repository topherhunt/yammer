import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSfx, FakeSttSource, FakeWakeWord } from "./fakes";
import { VoiceController } from "./voice-controller";
import type { VoiceIndicator } from "./voice-controller";

// The controller binds the pure machine to the real seams and owns the grace
// timer. Tested with fakes + vitest fake timers -- no hardware, no wall clock.

const GRACE_MS = 400;
const FINALIZE_MS = 5000;

function makeController() {
  const stt = new FakeSttSource();
  const wakeWord = new FakeWakeWord();
  const sfx = new FakeSfx();
  const submits: Array<{ text: string; seconds: number }> = [];
  const indicators: VoiceIndicator[] = [];
  const resumes: number[] = [];
  const errors: string[] = [];

  const controller = new VoiceController({
    stt,
    wakeWord,
    sfx,
    submit: (text, seconds) => submits.push({ text, seconds }),
    reflect: (indicator) => indicators.push(indicator),
    onResumeRequested: () => resumes.push(1),
    notifyError: (message) => errors.push(message),
    graceMs: GRACE_MS,
    finalizeMs: FINALIZE_MS,
  });

  return { controller, stt, wakeWord, sfx, submits, indicators, resumes, errors };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("tap-to-start", () => {
  it("start() opens capture on the STT source", () => {
    const { controller, stt } = makeController();
    controller.start();
    expect(stt.running).toBe(true);
    expect(controller.snapshot.mode).toBe("listening");
  });
});

describe("VAD -> pulse indicator", () => {
  it("reflects speaking as vad:true and silence as vad:false", () => {
    const { controller, stt, indicators } = makeController();
    controller.start();
    stt.emitVad(true);
    expect(indicators.at(-1)).toEqual({ vad: true, finalizing: false });
    stt.emitVad(false);
    // Silence -> finalizing (awaiting the STT final), so the radial shows.
    expect(indicators.at(-1)).toEqual({ vad: false, finalizing: true });
  });
});

describe("finalize + grace -> radial, then optimistic send", () => {
  it("shows the radial through finalize/grace and submits after the grace window", () => {
    const { controller, stt, sfx, submits, indicators } = makeController();
    controller.start();
    stt.emitVad(true);
    stt.emitVad(false);
    stt.emitFinal("hello there", 2);

    // In the grace window: radial on, nothing sent yet.
    expect(indicators.at(-1)).toEqual({ vad: false, finalizing: true });
    expect(submits).toEqual([]);

    // Before the window elapses -- still nothing.
    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(submits).toEqual([]);

    // Window elapses: submit fires with audio-seconds, send SFX plays, radial off.
    vi.advanceTimersByTime(1);
    expect(submits).toEqual([{ text: "hello there", seconds: 2 }]);
    expect(sfx.played).toEqual(["send"]);
    expect(indicators.at(-1)).toEqual({ vad: false, finalizing: false });
  });

  it("resumed speech within the grace window cancels the pending send", () => {
    const { controller, stt, submits } = makeController();
    controller.start();
    stt.emitVad(true);
    stt.emitVad(false);
    stt.emitFinal("half a thought", 1);

    // Barge back in before the window elapses.
    vi.advanceTimersByTime(GRACE_MS - 50);
    stt.emitVad(true);
    // Let the original timer's moment pass -- it must have been cancelled.
    vi.advanceTimersByTime(200);
    expect(submits).toEqual([]);

    // Finish the continued utterance; now it sends as one combined transcript.
    stt.emitVad(false);
    stt.emitFinal("finished now", 2);
    vi.advanceTimersByTime(GRACE_MS);
    expect(submits).toEqual([{ text: "half a thought finished now", seconds: 3 }]);
  });
});

describe("pause / mute via setListening", () => {
  it("pausing stops capture and starts the wake-word spotter", () => {
    const { controller, stt, wakeWord } = makeController();
    controller.start();
    controller.setListening("paused");
    expect(stt.running).toBe(false);
    expect(wakeWord.running).toBe(true);
  });

  it("muting stops both capture and the spotter", () => {
    const { controller, stt, wakeWord } = makeController();
    controller.start();
    controller.setListening("paused");
    controller.setListening("muted");
    expect(stt.running).toBe(false);
    expect(wakeWord.running).toBe(false);
  });
});

describe("wake word -> resume request", () => {
  it("a wake-word hit while paused requests a resume (does not flip state itself)", () => {
    const { controller, wakeWord, resumes } = makeController();
    controller.start();
    controller.setListening("paused");
    wakeWord.emitDetected();
    expect(resumes).toEqual([1]);
    // The controller waits for the resulting set_listening to drive it.
    expect(controller.snapshot.mode).toBe("paused");
    controller.setListening("listening");
    expect(controller.snapshot.mode).toBe("listening");
  });
});

describe("background / foreground", () => {
  it("releases capture when hidden and reopens it when visible", () => {
    const { controller, stt } = makeController();
    controller.start();
    expect(stt.running).toBe(true);
    controller.pageHidden();
    expect(stt.running).toBe(false);
    controller.pageVisible();
    expect(stt.running).toBe(true);
  });

  it("submits a just-finished (buffered) utterance instead of dropping it on HIDDEN", () => {
    const { controller, stt, submits } = makeController();
    controller.start();
    stt.emitVad(true);
    stt.emitVad(false);
    // FINAL landed -> buffered in the grace window, but the tab is backgrounded
    // before the grace timer elapses.
    stt.emitFinal("a finished thought", 2);
    expect(submits).toEqual([]);

    controller.pageHidden();
    // The completed utterance is flushed, not discarded.
    expect(submits).toEqual([{ text: "a finished thought", seconds: 2 }]);
    expect(stt.running).toBe(false);
    expect(controller.snapshot.suspended).toBe(true);
  });
});

describe("finalize timeout (dropped final must not hang)", () => {
  it("leaves finalizing to a surfaced retryable error when no FINAL lands", () => {
    const { controller, stt, errors, indicators } = makeController();
    controller.start();
    stt.emitVad(true);
    stt.emitVad(false); // -> finalizing, radial on, finalize timer armed

    expect(controller.snapshot.phase).toBe("finalizing");
    expect(indicators.at(-1)).toEqual({ vad: false, finalizing: true });

    // The STT final never arrives (e.g. a dropped socket). Just before the
    // timeout: still finalizing, no error yet.
    vi.advanceTimersByTime(FINALIZE_MS - 1);
    expect(errors).toEqual([]);
    expect(controller.snapshot.phase).toBe("finalizing");

    // Timeout fires: back to a listening/idle state (radial off) + a surfaced,
    // retryable error. The mic stays on.
    vi.advanceTimersByTime(1);
    expect(controller.snapshot.phase).toBe("silent");
    expect(controller.snapshot.mode).toBe("listening");
    expect(indicators.at(-1)).toEqual({ vad: false, finalizing: false });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/did not finish/i);
  });

  it("cancels the finalize timeout once the FINAL lands (no spurious error)", () => {
    const { controller, stt, errors, submits } = makeController();
    controller.start();
    stt.emitVad(true);
    stt.emitVad(false);
    stt.emitFinal("landed in time", 1); // FINAL arrives -> grace, timer cancelled

    // Advance past where the finalize timeout WOULD have fired: no error.
    vi.advanceTimersByTime(FINALIZE_MS + GRACE_MS);
    expect(errors).toEqual([]);
    expect(submits).toEqual([{ text: "landed in time", seconds: 1 }]);
  });
});

describe("capture-start failure (no lying 'listening')", () => {
  it("rejects start() and stands the machine back down when the mic is denied", async () => {
    const { controller, stt, errors } = makeController();
    stt.startError = new Error("Permission denied");

    await expect(controller.start()).rejects.toThrow(/Permission denied/);

    // The awaited tap path reports the failure to its caller (rethrow), not via
    // notifyError, and the machine is reverted out of listening.
    expect(errors).toEqual([]);
    expect(controller.snapshot.mode).toBe("muted");
    expect(stt.running).toBe(false);
  });

  it("surfaces an autonomous (wake-word resume) capture failure via notifyError", async () => {
    const { controller, stt, wakeWord, errors } = makeController();
    // Fully complete the tap-to-start (awaitingStart clears) before the resume.
    await controller.start();
    controller.setListening("paused");
    expect(wakeWord.running).toBe(true);

    // The mic is denied when trying to resume from pause (not an awaited tap).
    stt.startError = new Error("device in use");
    controller.setListening("listening");

    await Promise.resolve(); // let the rejected capture promise settle
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Microphone capture failed/i);
  });
});
