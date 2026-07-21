import type { SfxSound } from "@yammer/shared";
import type { MicCapture, Sfx, VadDetector, WakeWordDetector } from "./interfaces";
import type { SttSource } from "./voice-controller";

// In-memory fakes for the voice seams, used only by unit tests. Each records
// what the driver asked of it and exposes emit* drivers so tests can inject the
// events a real mic / VAD / socket would produce -- no hardware, no network.

export class FakeMicCapture implements MicCapture {
  readonly sampleRate: number;
  started = 0;
  stopped = 0;
  private frameCbs: Array<(frame: Int16Array) => void> = [];

  constructor(sampleRate = 16000) {
    this.sampleRate = sampleRate;
  }

  get running(): boolean {
    return this.started > this.stopped;
  }

  async start(): Promise<void> {
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
  }
  onFrame(cb: (frame: Int16Array) => void): void {
    this.frameCbs.push(cb);
  }
  emitFrame(frame: Int16Array): void {
    for (const cb of this.frameCbs) cb(frame);
  }
}

export class FakeVadDetector implements VadDetector {
  started = 0;
  stopped = 0;
  private startCbs: Array<() => void> = [];
  private endCbs: Array<() => void> = [];

  async start(): Promise<void> {
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
  }
  onSpeechStart(cb: () => void): void {
    this.startCbs.push(cb);
  }
  onSpeechEnd(cb: () => void): void {
    this.endCbs.push(cb);
  }
  emitSpeechStart(): void {
    for (const cb of this.startCbs) cb();
  }
  emitSpeechEnd(): void {
    for (const cb of this.endCbs) cb();
  }
}

export class FakeWakeWord implements WakeWordDetector {
  started = 0;
  stopped = 0;
  private cbs: Array<() => void> = [];

  get running(): boolean {
    return this.started > this.stopped;
  }

  start(): void {
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
  }
  onDetected(cb: () => void): void {
    this.cbs.push(cb);
  }
  emitDetected(): void {
    for (const cb of this.cbs) cb();
  }
}

export class FakeSfx implements Sfx {
  preloaded = false;
  unlocked = 0;
  readonly played: SfxSound[] = [];

  async preload(): Promise<void> {
    this.preloaded = true;
  }
  unlock(): void {
    this.unlocked += 1;
  }
  play(sound: SfxSound): void {
    this.played.push(sound);
  }
}

/** A fake STT source: the surface the controller consumes, with drivers standing
 * in for VAD + transcript events. */
export class FakeSttSource implements SttSource {
  started = 0;
  stopped = 0;
  /** When set, start() returns a rejected promise, standing in for a denied
   * getUserMedia / mic-permission failure. */
  startError: Error | null = null;
  private vadCbs: Array<(speaking: boolean) => void> = [];
  private interimCbs: Array<(text: string) => void> = [];
  private finalCbs: Array<(text: string, seconds: number) => void> = [];

  get running(): boolean {
    return this.started > this.stopped;
  }

  start(): void | Promise<void> {
    this.started += 1;
    if (this.startError) return Promise.reject(this.startError);
  }
  stop(): void {
    this.stopped += 1;
  }
  onVad(cb: (speaking: boolean) => void): void {
    this.vadCbs.push(cb);
  }
  onInterim(cb: (text: string) => void): void {
    this.interimCbs.push(cb);
  }
  onFinalDetailed(cb: (text: string, seconds: number) => void): void {
    this.finalCbs.push(cb);
  }
  emitVad(speaking: boolean): void {
    for (const cb of this.vadCbs) cb(speaking);
  }
  emitInterim(text: string): void {
    for (const cb of this.interimCbs) cb(text);
  }
  emitFinal(text: string, seconds: number): void {
    for (const cb of this.finalCbs) cb(text, seconds);
  }
}
