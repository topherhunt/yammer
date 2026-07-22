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
//
// stop() fully DESTROYS the VAD -- releasing its getUserMedia MediaStream and
// AudioContext -- rather than just pausing the algorithm. A mere pause() leaves
// the OS "mic in use" indicator lit while the user believes they are muted, a
// privacy/trust failure; teardown extinguishes it. A subsequent start() rebuilds
// the graph. Callbacks are kept across rebuilds (they close over these arrays).

export class SileroVadDetector implements VadDetector {
  private vad: MicVAD | null = null;
  private startCbs: Array<() => void> = [];
  private endCbs: Array<() => void> = [];

  async start(): Promise<void> {
    if (!this.vad) {
      this.vad = await MicVAD.new({
        // Load the VAD worklet + Silero model and the onnxruntime WASM from a
        // version-pinned CDN so they resolve reliably under Vite (which cannot
        // pre-bundle the ort WASM). Versions must match the installed packages.
        baseAssetPath: "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/",
        onnxWASMBasePath: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/",
        // Silence (ms) after speech before we declare the sentence over. Too low and
        // it cuts off mid-sentence on a natural pause and ships a half-sentence; too
        // high and the reply feels laggy. 1000ms leaves room to draw breath between
        // clauses. This is THE knob for "it keeps cutting me off" -- raise it further
        // (1200-1500) if pauses still trip it. (Total wait before send is this plus
        // the optimistic-send grace window.) Overridable via VITE_VAD_REDEMPTION_MS.
        redemptionMs: Number(import.meta.env.VITE_VAD_REDEMPTION_MS) || 2000,
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
    // Fully release the stream + AudioContext, not just pause() the algorithm, so
    // the mic-in-use indicator actually goes dark on mute.
    const vad = this.vad;
    this.vad = null;
    void vad?.destroy();
  }

  onSpeechStart(cb: () => void): void {
    this.startCbs.push(cb);
  }

  onSpeechEnd(cb: () => void): void {
    this.endCbs.push(cb);
  }
}
