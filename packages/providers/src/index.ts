// Provider implementations behind the frozen @yammer/shared interfaces. No
// provider-specific code (OpenAI, Tavily, ...) leaks past this package into
// domain logic -- swapping a model or search vendor is a config change here.
//
// These exports are the cross-package contract (imported as @yammer/providers by
// the server and web agents) and must not change signature without updating every
// caller. LlmProvider/LlmRequest/LlmResult/SearchProvider/SearchResult/Usage all
// come from @yammer/shared and are never redefined here.

export {
  type LlmProviderConfig,
  createLlmProvider,
  MockLlmProvider,
  // Structured-output schema + pure mapping/parsing helpers, exported for
  // unit tests and any edge that wants to introspect the envelope shape.
  yammerTurnJsonSchema,
  mapOpenAiUsage,
  parseOpenAiResponse,
  type OpenAiUsageLike,
  type OpenAiResponseLike,
} from "./openai-llm";

export {
  type SearchProviderConfig,
  createSearchProvider,
  MockSearchProvider,
  mapTavilyResult,
} from "./tavily-search";
