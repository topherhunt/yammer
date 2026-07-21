import type { SfxSound } from "@yammer/shared";

// Thin, guarded wrappers around browser-only side effects the reducer requests.
// Every one no-ops safely when its API is unavailable (jsdom/tests), so the
// store's effect handling never crashes headless.

export function downloadFile(filename: string, content: BlobPart, mime: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return;
  }
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function copyToClipboard(text: string): Promise<void> {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clip?.writeText) return;
  await clip.writeText(text);
}

// A short synthesized tone per state change (send / mute / unmute / error).
// Kept intentionally minimal here; richer SFX design is a Phase 6 concern.
const TONES: Record<SfxSound, number> = {
  send: 660,
  unmute: 880,
  mute: 330,
  error: 220,
};

export function playSfx(sound: SfxSound): void {
  const Ctor =
    typeof window !== "undefined"
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext)
      : undefined;
  if (!Ctor) return;
  try {
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = TONES[sound];
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    osc.onended = () => void ctx.close();
  } catch {
    // Audio not available (autoplay policy, headless) -- SFX is non-essential.
  }
}
