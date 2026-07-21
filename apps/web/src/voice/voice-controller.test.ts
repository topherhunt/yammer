import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSfx, FakeSttSource, FakeWakeWord } from "./fakes";
import { VoiceController } from "./voice-controller";
import type { VoiceIndicator } from "./voice-controller";

// The controller binds the pure machine to the real seams and owns the grace
// timer. Tested with fakes + vitest fake timers -- no hardware, no wall clock.

const GRACE_MS = 400;

function makeController() {
  const stt = new FakeSttSource();
  const wakeWord = new FakeWakeWord();
  const sfx = new FakeSfx();
  const submits: Array<{ text: string; seconds: number }> = [];
  const indicators: VoiceIndicator[] = [];
  const resumes: number[] = [];

  const controller = new VoiceController({
    stt,
    wakeWord,
    sfx,
    submit: (text, seconds) => submits.push({ text, seconds }),
    reflect: (indicator) => indicators.push(indicator),
    onResumeRequested: () => resumes.push(1),
    graceMs: GRACE_MS,
  });

  return { controller, stt, wakeWord, sfx, submits, indicators, resumes };
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
});
