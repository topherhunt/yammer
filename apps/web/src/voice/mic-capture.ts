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

export class BrowserMicCapture implements MicCapture {
  sampleRate = STT_SAMPLE_RATE;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private frameCbs: Array<(frame: Int16Array) => void> = [];

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
  }

  onFrame(cb: (frame: Int16Array) => void): void {
    this.frameCbs.push(cb);
  }
}
