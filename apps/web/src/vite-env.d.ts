/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Yammer API. When set, the app uses the real fetch-backed
   * client; when unset (dev/tests), it falls back to the in-memory mock. */
  readonly VITE_API_BASE?: string;
  /** URL of the Vosk wake-word model .tar.gz. Defaults to a public path. */
  readonly VITE_VOSK_MODEL_URL?: string;
}
