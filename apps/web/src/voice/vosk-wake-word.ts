import { createModel, type KaldiRecognizer, type Model } from "vosk-browser";
import type { WakeWordDetector } from "./interfaces";

// Open-source, keyless, on-device wake-word spotter using Vosk (vosk-browser,
// Apache-2.0) running a small English model in a WASM worker. It listens ONLY
// while paused (its own low-power mic tap, separate from the main STT pipeline,
// which is stopped during pause), and fires when it hears "Yammer, wake up".
//
// Chosen over Picovoice Porcupine specifically to avoid a key/registration.
// Tradeoff (see plan.md sec 16): the model is a ~40MB one-time download and this
// is heavier than a purpose-built spotter -- a lighter open-source replacement is
// a tracked future optimization behind this same interface.
//
// Browser-only (AudioContext + getUserMedia + WASM): verified in a real browser,
// not in jsdom. The model download is lazy -- it happens on the first start()
// (i.e. the first pause), not at app load.

const DEFAULT_MODEL_URL = "/models/vosk-model-small-en-us.tar.gz";

// Grammar restricts the recognizer's vocabulary to the wake phrase plus the
// out-of-vocabulary token, which sharply improves accuracy and speed for a
// single-phrase spotter.
const WAKE_PHRASE = "yammer wake up";
const GRAMMAR = JSON.stringify([WAKE_PHRASE, "[unk]"]);

// Minimum per-word confidence to accept a wake. The grammar makes even a weak
// "yam" transcribe as the full phrase, but the words you did not actually say
// come back with low confidence -- so this is the real false-wake filter. Tune
// UP to be stricter (fewer false wakes, more misses on an unclear voice); tune
// DOWN if the real phrase is being missed.
const DEFAULT_MIN_CONFIDENCE = 0.4;

interface VoskResult {
  text: string;
  result?: Array<{ conf: number; word: string }>;
}

/** Accept only when the recognized text IS the wake phrase and every recognized
 * word clears the confidence bar. Uses the min (every) rather than average so a
 * single confidently-absent word ("wake"/"up" you didn't say) blocks the wake. */
function isConfidentWake(result: VoskResult, minConfidence: number): boolean {
  if (!result.text.toLowerCase().includes(WAKE_PHRASE)) return false;
  const words = result.result ?? [];
  return words.length > 0 && words.every((w) => w.conf >= minConfidence);
}

export interface VoskWakeWordOptions {
  /** URL of a Vosk model .tar.gz (host it in the web app's public dir). */
  modelUrl?: string;
  /** Per-word confidence bar for a wake (0..1). Default 0.7. */
  minConfidence?: number;
}

export class VoskWakeWord implements WakeWordDetector {
  private readonly modelUrl: string;
  private readonly minConfidence: number;
  private readonly cbs: Array<() => void> = [];

  private running = false;
  private model: Model | null = null;
  private modelPromise: Promise<Model> | null = null;

  private stream: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private recognizer: KaldiRecognizer | null = null;

  constructor(options: VoskWakeWordOptions = {}) {
    this.modelUrl = options.modelUrl ?? DEFAULT_MODEL_URL;
    this.minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  }

  onDetected(cb: () => void): void {
    this.cbs.push(cb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Fire-and-forget async setup; failures leave the spotter inert (the user
    // can still resume by clicking), surfaced loudly rather than swallowed.
    void this.spinUp().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[wake-word] Vosk spotter failed to start:", err);
      this.teardown();
      this.running = false;
    });
  }

  stop(): void {
    this.running = false;
    this.teardown();
  }

  private async spinUp(): Promise<void> {
    const model = await this.loadModel();
    // A stop() may have raced in during the model load/mic grant.
    if (!this.running) return;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!this.running) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;

    const audio = new AudioContext();
    this.audio = audio;
    const recognizer = new model.KaldiRecognizer(audio.sampleRate, GRAMMAR);
    this.recognizer = recognizer;

    // Only final results -- partials are unstable and cause premature wakes on a
    // fleeting "yam". The final result carries per-word confidence for the gate.
    recognizer.on("result", (message) => {
      if (message.event === "result") this.consider(message.result);
    });

    const source = audio.createMediaStreamSource(stream);
    this.source = source;
    const processor = audio.createScriptProcessor(4096, 1, 1);
    this.processor = processor;
    processor.onaudioprocess = (event) => {
      try {
        recognizer.acceptWaveformFloat(
          event.inputBuffer.getChannelData(0),
          audio.sampleRate,
        );
      } catch {
        // A late frame after teardown -- ignore.
      }
    };
    source.connect(processor);
    processor.connect(audio.destination);
  }

  private consider(result: VoskResult): void {
    if (this.running && isConfidentWake(result, this.minConfidence)) {
      // Fire once per activation; stop() before re-arming on the next pause.
      this.stop();
      for (const cb of this.cbs) cb();
    }
  }

  private loadModel(): Promise<Model> {
    if (this.model) return Promise.resolve(this.model);
    if (!this.modelPromise) {
      this.modelPromise = createModel(this.modelUrl).then((m) => {
        this.model = m;
        return m;
      });
    }
    return this.modelPromise;
  }

  private teardown(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    if (this.processor) this.processor.onaudioprocess = null;
    this.recognizer?.remove();
    void this.audio?.close().catch(() => {});
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.processor = null;
    this.source = null;
    this.recognizer = null;
    this.audio = null;
    this.stream = null;
    // The loaded model is kept (cached) so re-arming on the next pause is instant.
  }
}
