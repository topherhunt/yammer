import { MicVAD } from "@ricky0123/vad-web";
import type { VadDetector } from "./interfaces";

// Real client-side VAD via @ricky0123/vad-web (Silero WASM). Browser-only and
// thin; all consumers drive it through the VadDetector seam and are tested with
// FakeVadDetector. This module statically imports vad-web (which pulls in
// onnxruntime-web), so it must only ever be loaded in the browser via the
// dynamic import in create-voice.ts -- never in the test/module graph.
//
// The VAD immediately drives the pulse indicator (no network round-trip) and
// gates when the STT client streams audio, so pure silence is not sent or billed.

export class SileroVadDetector implements VadDetector {
  private vad: MicVAD | null = null;
  private startCbs: Array<() => void> = [];
  private endCbs: Array<() => void> = [];

  async start(): Promise<void> {
    if (!this.vad) {
      this.vad = await MicVAD.new({
        onSpeechStart: () => {
          for (const cb of this.startCbs) cb();
        },
        onSpeechEnd: () => {
          for (const cb of this.endCbs) cb();
        },
      });
    }
    await this.vad.start();
  }

  stop(): void {
    void this.vad?.pause();
  }

  onSpeechStart(cb: () => void): void {
    this.startCbs.push(cb);
  }

  onSpeechEnd(cb: () => void): void {
    this.endCbs.push(cb);
  }
}
