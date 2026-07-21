import type { SfxSound } from "@yammer/shared";
import type { Sfx } from "./interfaces";

// Real Web Audio SFX. The user watches the document, not the indicator, so sound
// carries the state changes: a short `send` beep the instant an utterance is
// dispatched, a rising `unmute` note ("you're live"), and a lower/falling `mute`
// note ("you're muted"). Buffers are synthesized once and preloaded so playback
// has no first-hit lag. This is browser-only (Web Audio); tests use FakeSfx.

interface ToneSpec {
  /** Frequency envelope endpoints (Hz): rising for unmute, falling for mute. */
  from: number;
  to: number;
  durationMs: number;
  gain: number;
}

// Distinct, short, non-intrusive tones. `unmute` rises and `mute` falls so the
// two are unmistakable even without looking.
const TONES: Record<SfxSound, ToneSpec> = {
  send: { from: 660, to: 660, durationMs: 90, gain: 0.05 },
  unmute: { from: 660, to: 990, durationMs: 140, gain: 0.06 },
  mute: { from: 520, to: 300, durationMs: 160, gain: 0.06 },
  error: { from: 220, to: 180, durationMs: 200, gain: 0.06 },
};

function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  );
}

export class WebAudioSfx implements Sfx {
  private ctx: AudioContext | null = null;
  private readonly buffers = new Map<SfxSound, AudioBuffer>();

  async preload(): Promise<void> {
    const Ctor = audioContextCtor();
    if (!Ctor) return; // headless / unsupported -- SFX is non-essential
    if (!this.ctx) this.ctx = new Ctor();
    for (const sound of Object.keys(TONES) as SfxSound[]) {
      if (!this.buffers.has(sound)) {
        this.buffers.set(sound, this.render(this.ctx, TONES[sound]));
      }
    }
    // A user gesture already unlocked audio (the tap-to-start gate), but resume
    // defensively in case the context started suspended.
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  play(sound: SfxSound): void {
    const ctx = this.ctx;
    const buffer = this.buffers.get(sound);
    if (!ctx || !buffer) return;
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
    } catch {
      // Autoplay policy or a torn-down context -- SFX must never crash the app.
    }
  }

  /** Synthesize a short tone with a linear frequency glide and an eased envelope
   * into an offline-free AudioBuffer we can replay with zero latency. */
  private render(ctx: BaseAudioContext, spec: ToneSpec): AudioBuffer {
    const sampleRate = ctx.sampleRate;
    const length = Math.max(1, Math.floor((spec.durationMs / 1000) * sampleRate));
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const freq = spec.from + (spec.to - spec.from) * t;
      phase += (2 * Math.PI * freq) / sampleRate;
      // A raised-cosine envelope avoids clicks at onset/offset.
      const envelope = Math.sin(Math.PI * t);
      data[i] = Math.sin(phase) * envelope * spec.gain;
    }
    return buffer;
  }
}
