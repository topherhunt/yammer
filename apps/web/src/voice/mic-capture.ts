import type { MicCapture } from "./interfaces";

// Real PCM16 mic capture (getUserMedia + an AudioWorklet). Browser-only and thin
// by design -- all logic that consumes frames lives behind the MicCapture seam
// and is tested with FakeMicCapture. Verified later in a real browser.
//
// The worklet downmixes to mono and posts Float32 frames back to the main thread,
// where we convert to PCM16 at the graph's sample rate. TODO(voice): share this
// MediaStream with the VAD (MicVAD) instead of opening the mic twice; kept
// separate for now so each seam stays independently swappable.

const WORKLET_SOURCE = `
class PcmFrameProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // Copy: the underlying buffer is reused across process() calls.
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}
registerProcessor('pcm-frame-processor', PcmFrameProcessor);
`;

function floatToPcm16(frame: Float32Array): Int16Array {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const clamped = Math.max(-1, Math.min(1, frame[i] ?? 0));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

// OpenAI GA realtime transcription requires exactly 24 kHz mono PCM, so we force
// the capture graph to 24 kHz (the browser resamples the mic input for us) rather
// than streaming the hardware rate (typically 48 kHz) and being rejected.
const STT_SAMPLE_RATE = 24000;

// Speech RMS tops out well below 1.0; this maps a "full" speaking level to 1.0 so
// the indicator swings across a useful range rather than barely twitching.
const LEVEL_FULL_SCALE = 0.15;
// Emit a level every Nth worklet frame. The worklet posts a 128-sample quantum,
// so at 24 kHz that is ~187 frames/s; every 6th is ~31 updates/s -- smooth without
// thrashing the store/UI.
const LEVEL_EMIT_EVERY = 6;

export class BrowserMicCapture implements MicCapture {
  sampleRate = STT_SAMPLE_RATE;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private frameCbs: Array<(frame: Int16Array) => void> = [];
  private levelCbs: Array<(level: number) => void> = [];
  private smoothedLevel = 0;
  private frameCount = 0;

  async start(): Promise<void> {
    if (this.ctx) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stream = stream;
    const ctx = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;

    const url = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "pcm-frame-processor");
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      const pcm = floatToPcm16(ev.data);
      for (const cb of this.frameCbs) cb(pcm);
      if (this.levelCbs.length) this.emitLevel(ev.data);
    };
    source.connect(node);
    this.node = node;
  }

  stop(): void {
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
    this.smoothedLevel = 0;
    this.frameCount = 0;
  }

  onFrame(cb: (frame: Int16Array) => void): void {
    this.frameCbs.push(cb);
  }

  onLevel(cb: (level: number) => void): void {
    this.levelCbs.push(cb);
  }

  /** Compute the RMS of this frame, smooth it (fast attack so a loud syllable
   * pops immediately, slow release so it eases back rather than flickering), and
   * emit a normalized 0..1 level every Nth frame. */
  private emitLevel(frame: Float32Array): void {
    let sumSquares = 0;
    for (let i = 0; i < frame.length; i++) {
      const sample = frame[i] ?? 0;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, frame.length));
    // Attack instantly toward a louder level; release ~15%/frame toward quiet.
    this.smoothedLevel = Math.max(rms, this.smoothedLevel * 0.85);

    this.frameCount += 1;
    if (this.frameCount % LEVEL_EMIT_EVERY !== 0) return;
    const level = Math.min(1, this.smoothedLevel / LEVEL_FULL_SCALE);
    for (const cb of this.levelCbs) cb(level);
  }
}
