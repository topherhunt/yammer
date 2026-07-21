import type { SttProvider } from "@yammer/shared";

// A test/dev SttProvider: no microphone, no network. Tests inject transcripts
// via emitFinal (as if the user finished an utterance) and toggle VAD via
// emitVad to exercise the listening indicator. Phase 4 swaps in the real
// gpt-realtime-whisper provider behind this same interface.

export class MockStt implements SttProvider {
  private interimCbs: Array<(text: string) => void> = [];
  private finalCbs: Array<(text: string) => void> = [];
  private vadCbs: Array<(speaking: boolean) => void> = [];

  started = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.started = false;
  }

  onInterim(cb: (text: string) => void): void {
    this.interimCbs.push(cb);
  }

  onFinal(cb: (text: string) => void): void {
    this.finalCbs.push(cb);
  }

  onVad(cb: (speaking: boolean) => void): void {
    this.vadCbs.push(cb);
  }

  // -- test/dev drivers --

  emitInterim(text: string): void {
    for (const cb of this.interimCbs) cb(text);
  }

  emitFinal(text: string): void {
    for (const cb of this.finalCbs) cb(text);
  }

  emitVad(speaking: boolean): void {
    for (const cb of this.vadCbs) cb(speaking);
  }
}
