import type { SfxSound } from "@yammer/shared";

// The real-browser seams for the voice pipeline. Every hardware/OS touchpoint
// (mic, VAD model, wake-word spotter, audio output) lives behind one of these
// interfaces so the logic that drives them (the listening machine + controller)
// is unit-tested against fakes and never touches real hardware in a test.

/** Raw PCM16 mic capture. Real impl = getUserMedia + an audio graph; the fake
 * emits injected frames. Frames are mono PCM16 at `sampleRate`. */
export interface MicCapture {
  readonly sampleRate: number;
  /** Begin capturing. Rejects if permission is denied. */
  start(): Promise<void>;
  stop(): void;
  /** One PCM16 frame per callback invocation. */
  onFrame(cb: (frame: Int16Array) => void): void;
  /** Optional: smoothed input level (0..1), emitted ~30x/s while capturing, for the
   * amplitude-reactive mic indicator. Real impl only; fakes may omit it. */
  onLevel?(cb: (level: number) => void): void;
}

/** Voice-activity detection. Real impl = @ricky0123/vad-web (Silero WASM); the
 * fake exposes emit* drivers. Gates streaming (so silence is not charged) and
 * drives the pulse indicator. */
export interface VadDetector {
  start(): Promise<void>;
  stop(): void;
  onSpeechStart(cb: () => void): void;
  onSpeechEnd(cb: () => void): void;
}

/** On-device wake-word spotter, alive only while paused so "Yammer, wake up"
 * resumes hands-free. Real impl = VoskWakeWord (vosk-wake-word.ts): open-source,
 * keyless, on-device (Apache-2.0). */
export interface WakeWordDetector {
  start(): void;
  stop(): void;
  onDetected(cb: () => void): void;
}

/** Preloaded sound effects. Real impl = Web Audio buffers; the fake records what
 * played. `send` confirms a dispatched utterance; `mute`/`unmute` mark state. */
export interface Sfx {
  /** Preload buffers so playback has no first-hit lag. Safe to call repeatedly. */
  preload(): Promise<void>;
  /** Synchronously create + resume the shared AudioContext inside the tap-to-start
   * gesture, BEFORE any await, so iOS Safari does not leave it suspended (which
   * yields a silent first SFX / no worklet). Safe to call repeatedly. */
  unlock(): void;
  play(sound: SfxSound): void;
}
