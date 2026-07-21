// Recency-fading yellow edit highlights (the STT-correction affordance). When
// an AI edit lands, the changed range glows yellow and fades over ~15s so the
// user can see what changed and how recently. Older = more faded, so a still-
// glowing wrong word is obviously the freshest change to correct.

export const HIGHLIGHT_DURATION_MS = 15_000;

/**
 * Opacity (0..1) for a highlight of the given age. Full at birth, linearly
 * fading to 0 at HIGHLIGHT_DURATION_MS, clamped outside that window. Pure so
 * the fade curve is unit-tested independently of the DOM.
 */
export function highlightOpacity(
  ageMs: number,
  durationMs: number = HIGHLIGHT_DURATION_MS,
): number {
  if (ageMs <= 0) return 1;
  if (ageMs >= durationMs) return 0;
  return 1 - ageMs / durationMs;
}
