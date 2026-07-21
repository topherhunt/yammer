/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional origin override for the API. Defaults to "" (same origin, served
   * by the single-process server). Only set if the API is hosted elsewhere. */
  readonly VITE_API_BASE?: string;
  /** Set to "1" for the backend-less mock demo (seed doc, no real API/voice). */
  readonly VITE_MOCK?: string;
  /** URL of the Vosk wake-word model .tar.gz. Defaults to a public path. */
  readonly VITE_VOSK_MODEL_URL?: string;
  /** Per-word confidence bar for the wake word (0..1). Higher = stricter. */
  readonly VITE_VOSK_MIN_CONFIDENCE?: string;
}
