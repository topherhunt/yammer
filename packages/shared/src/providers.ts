// Pluggable seams for everything external. No provider-specific code may leak
// past these interfaces into domain logic. Swapping a model or search vendor is
// a config change, not a code change.

/** Token/audio accounting for one turn, used by the per-document spend meter. */
export interface Usage {
  sttSeconds: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export const zeroUsage: Usage = {
  sttSeconds: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
};

export interface LlmMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  model: string;
}

export interface LlmResult {
  chatMessage?: string;
  /** Unvalidated actions; the caller validates against actionSchema. */
  actions: unknown[];
  usage: Usage;
  /** The full raw provider response, persisted to the diagnostic log. */
  raw: unknown;
}

export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmResult>;
}

/** Streaming speech-to-text. Interim results drive the live indicator; the
 * final result is what gets sent to the LLM. */
export interface SttProvider {
  start(): void;
  stop(): void;
  onInterim(cb: (text: string) => void): void;
  onFinal(cb: (text: string) => void): void;
  onVad(cb: (speaking: boolean) => void): void;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Cleaned page content when the provider returns it inline (Tavily/Exa). */
  content?: string;
}

export interface SearchProvider {
  search(query: string): Promise<SearchResult[]>;
  fetchContent(url: string): Promise<string>;
}
