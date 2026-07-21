import type { ListeningState } from "@yammer/shared";
import type { Sfx, WakeWordDetector } from "./interfaces";
import {
  indicatorFor,
  initialListeningState,
  reduceListening,
} from "./listening-machine";
import type {
  ListeningCommand,
  ListeningEvent,
  ListeningState as MachineState,
} from "./listening-machine";

// The driver that binds the pure listening machine to the real seams. It owns
// the one piece of timing the machine deliberately doesn't -- the pre-send grace
// window -- and translates machine commands into calls on the injected mic/STT,
// wake-word, and SFX. Everything here is unit-tested with fakes and fake timers.

/** What the controller needs from the STT layer. WsSttClient implements this
 * (plus SttProvider); the extra `onFinalDetailed` carries the audio-seconds the
 * frozen SttProvider.onFinal cannot. */
export interface SttSource {
  start(): void;
  stop(): void;
  onVad(cb: (speaking: boolean) => void): void;
  onInterim(cb: (text: string) => void): void;
  onFinalDetailed(cb: (text: string, seconds: number) => void): void;
}

export interface VoiceIndicator {
  vad: boolean;
  finalizing: boolean;
}

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (h) => clearTimeout(h),
};

export interface VoiceControllerDeps {
  stt: SttSource;
  wakeWord: WakeWordDetector;
  sfx: Sfx;
  /** Dispatch a finished utterance into the turn loop (store.submitTranscript). */
  submit: (text: string, seconds: number) => void;
  /** Push derived UI signals into the view (store.setVoiceIndicator). */
  reflect: (indicator: VoiceIndicator) => void;
  /** A wake-word hit requests a resume; the edge maps this to a set_listening
   * action so app.listening + the unmute SFX flow through the reducer, keeping
   * the store authoritative rather than the controller flipping state directly. */
  onResumeRequested: () => void;
  /** Pre-send grace window (ms) -- resumed speech within it cancels the send. */
  graceMs: number;
  timers?: Timers;
}

export class VoiceController {
  private state: MachineState = initialListeningState;
  private graceHandle: number | null = null;
  private readonly timers: Timers;

  constructor(private readonly deps: VoiceControllerDeps) {
    this.timers = deps.timers ?? realTimers;

    deps.stt.onVad((speaking) =>
      this.send({ type: speaking ? "SPEECH_START" : "SPEECH_END" }),
    );
    deps.stt.onInterim((text) => this.send({ type: "INTERIM", text }));
    deps.stt.onFinalDetailed((text, seconds) =>
      this.send({ type: "FINAL", text, seconds }),
    );
    deps.wakeWord.onDetected(() => deps.onResumeRequested());
  }

  /** Current machine snapshot (for tests + debugging). */
  get snapshot(): MachineState {
    return this.state;
  }

  /** Tap-to-start: the first user gesture that grants the mic. */
  start(): void {
    this.send({ type: "START" });
  }

  /** Drive a listen/pause/mute transition (from the set_listening effect). */
  setListening(mode: ListeningState): void {
    if (mode === "listening") {
      this.send({ type: this.state.mode === "idle" ? "START" : "RESUME" });
    } else if (mode === "paused") {
      this.send({ type: "PAUSE" });
    } else {
      this.send({ type: "MUTE" });
    }
  }

  /** Page Visibility bridge -- the edge calls these on visibilitychange. */
  pageHidden(): void {
    this.send({ type: "HIDDEN" });
  }
  pageVisible(): void {
    this.send({ type: "VISIBLE" });
  }

  private send(event: ListeningEvent): void {
    const { state, commands } = reduceListening(this.state, event);
    this.state = state;
    for (const command of commands) this.execute(command);
    this.deps.reflect(indicatorFor(this.state));
  }

  private execute(command: ListeningCommand): void {
    switch (command.type) {
      case "START_CAPTURE":
        this.deps.stt.start();
        break;
      case "STOP_CAPTURE":
        this.deps.stt.stop();
        break;
      case "START_WAKEWORD":
        this.deps.wakeWord.start();
        break;
      case "STOP_WAKEWORD":
        this.deps.wakeWord.stop();
        break;
      case "SCHEDULE_GRACE":
        this.clearGrace();
        this.graceHandle = this.timers.setTimeout(() => {
          this.graceHandle = null;
          this.send({ type: "GRACE_ELAPSED" });
        }, this.deps.graceMs);
        break;
      case "CANCEL_GRACE":
        this.clearGrace();
        break;
      case "SUBMIT":
        this.deps.submit(command.text, command.seconds);
        break;
      case "PLAY_SFX":
        this.deps.sfx.play(command.sound);
        break;
    }
  }

  private clearGrace(): void {
    if (this.graceHandle !== null) {
      this.timers.clearTimeout(this.graceHandle);
      this.graceHandle = null;
    }
  }
}
