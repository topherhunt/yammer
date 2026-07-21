import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmResult } from "@yammer/shared";

// Mock the openai SDK so createLlmProvider never touches the network. The mocked
// client records constructor options and lets each test stage a `create` result.
const { createMock, ctorMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  ctorMock: vi.fn(),
}));
vi.mock("openai", () => ({
  default: class {
    responses = { create: createMock };
    constructor(opts: unknown) {
      ctorMock(opts);
    }
  },
}));

import {
  createLlmProvider,
  MockLlmProvider,
  mapOpenAiUsage,
  parseOpenAiResponse,
  yammerTurnJsonSchema,
} from "./openai-llm";

beforeEach(() => {
  createMock.mockReset();
  ctorMock.mockReset();
});

describe("mapOpenAiUsage", () => {
  it("maps input/output/cached token counts and zeroes STT", () => {
    const usage = mapOpenAiUsage({
      input_tokens: 1200,
      output_tokens: 80,
      input_tokens_details: { cached_tokens: 1000 },
    });
    expect(usage).toEqual({
      sttSeconds: 0,
      inputTokens: 1200,
      cachedInputTokens: 1000,
      outputTokens: 80,
    });
  });

  it("defaults cachedInputTokens to 0 when the details block omits it", () => {
    const usage = mapOpenAiUsage({ input_tokens: 50, output_tokens: 10 });
    expect(usage.cachedInputTokens).toBe(0);
    expect(usage.inputTokens).toBe(50);
  });

  it("throws when usage is absent rather than reporting zero spend", () => {
    expect(() => mapOpenAiUsage(undefined)).toThrow(/missing token usage/);
  });
});

describe("parseOpenAiResponse", () => {
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 0 },
  };

  it("extracts chatMessage and the raw actions array from structured output", () => {
    const result = parseOpenAiResponse({
      output_text: JSON.stringify({
        chatMessage: "Done.",
        actions: [{ type: "scroll", direction: "down" }],
      }),
      usage,
    });
    expect(result.chatMessage).toBe("Done.");
    expect(result.actions).toEqual([{ type: "scroll", direction: "down" }]);
    expect(result.usage.outputTokens).toBe(5);
  });

  it("returns the full response object as `raw` for the diagnostic log", () => {
    const response = { output_text: JSON.stringify({ actions: [] }), usage };
    const result = parseOpenAiResponse(response);
    expect(result.raw).toBe(response);
  });

  it("omits chatMessage when the envelope leaves it out", () => {
    const result = parseOpenAiResponse({
      output_text: JSON.stringify({ actions: [] }),
      usage,
    });
    expect(result.chatMessage).toBeUndefined();
    expect(result.actions).toEqual([]);
  });

  it("does not validate individual actions -- it passes them through untouched", () => {
    const result = parseOpenAiResponse({
      output_text: JSON.stringify({ actions: [{ type: "not_a_real_action" }] }),
      usage,
    });
    expect(result.actions).toEqual([{ type: "not_a_real_action" }]);
  });

  it("throws on empty output text", () => {
    expect(() => parseOpenAiResponse({ output_text: "   ", usage })).toThrow(
      /no output text/,
    );
  });

  it("throws on non-JSON output", () => {
    expect(() =>
      parseOpenAiResponse({ output_text: "not json {", usage }),
    ).toThrow(/not valid JSON/);
  });

  it("throws when the JSON is not an object", () => {
    expect(() =>
      parseOpenAiResponse({ output_text: "[1,2,3]", usage }),
    ).toThrow(/not an object/);
  });

  it("throws when the actions array is missing", () => {
    expect(() =>
      parseOpenAiResponse({ output_text: JSON.stringify({ chatMessage: "hi" }), usage }),
    ).toThrow(/missing an "actions" array/);
  });

  it("throws when chatMessage is present but not a string", () => {
    expect(() =>
      parseOpenAiResponse({
        output_text: JSON.stringify({ chatMessage: 42, actions: [] }),
        usage,
      }),
    ).toThrow(/"chatMessage" was not a string/);
  });
});

describe("createLlmProvider", () => {
  it("forwards apiKey and baseUrl to the OpenAI client", () => {
    createLlmProvider({ apiKey: "sk-test", model: "gpt-5.6-luna", baseUrl: "https://proxy" });
    expect(ctorMock).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://proxy",
    });
  });

  it("calls the Responses API with json_schema structured output and maps the result", async () => {
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        chatMessage: "Scrolling.",
        actions: [{ type: "scroll", direction: "up" }],
      }),
      usage: { input_tokens: 30, output_tokens: 4, input_tokens_details: { cached_tokens: 20 } },
    });

    const provider = createLlmProvider({ apiKey: "sk-test", model: "gpt-5.6-luna" });
    const result = await provider.complete({
      system: "You are Yammer.",
      messages: [{ role: "user", content: "scroll up" }],
      model: "gpt-5.6-terra",
    });

    const params = createMock.mock.calls[0]![0];
    expect(params.model).toBe("gpt-5.6-terra"); // per-request model wins
    expect(params.instructions).toBe("You are Yammer.");
    expect(params.input).toEqual([{ role: "user", content: "scroll up" }]);
    expect(params.text.format.type).toBe("json_schema");
    expect(params.text.format.schema).toBe(yammerTurnJsonSchema);

    expect(result.chatMessage).toBe("Scrolling.");
    expect(result.actions).toEqual([{ type: "scroll", direction: "up" }]);
    expect(result.usage).toEqual({
      sttSeconds: 0,
      inputTokens: 30,
      cachedInputTokens: 20,
      outputTokens: 4,
    });
  });

  it("falls back to the config model when the request omits one", async () => {
    createMock.mockResolvedValue({
      output_text: JSON.stringify({ actions: [] }),
      usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
    });
    const provider = createLlmProvider({ apiKey: "k", model: "gpt-5.6-luna" });
    await provider.complete({ system: "s", messages: [], model: "" });
    expect(createMock.mock.calls[0]![0].model).toBe("gpt-5.6-luna");
  });
});

describe("yammerTurnJsonSchema", () => {
  it("pins the { chatMessage?, actions[] } envelope with actions required", () => {
    expect(yammerTurnJsonSchema.type).toBe("object");
    expect(yammerTurnJsonSchema.required).toEqual(["actions"]);
    const props = yammerTurnJsonSchema.properties as Record<string, { type: string }>;
    expect(props.chatMessage!.type).toBe("string");
    expect(props.actions!.type).toBe("array");
  });
});

describe("MockLlmProvider", () => {
  const make = (chatMessage: string): LlmResult => ({
    chatMessage,
    actions: [],
    usage: { sttSeconds: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    raw: {},
  });

  it("replays canned results in order across successive complete() calls", async () => {
    const provider = new MockLlmProvider([make("first"), make("second")]);
    expect((await provider.complete({ system: "", messages: [], model: "" })).chatMessage).toBe("first");
    expect((await provider.complete({ system: "", messages: [], model: "" })).chatMessage).toBe("second");
  });

  it("throws once the staged results are exhausted", async () => {
    const provider = new MockLlmProvider([make("only")]);
    await provider.complete({ system: "", messages: [], model: "" });
    await expect(
      provider.complete({ system: "", messages: [], model: "" }),
    ).rejects.toThrow(/no canned result for call #2/);
  });

  it("throws immediately when constructed with no canned results", async () => {
    const provider = new MockLlmProvider();
    await expect(
      provider.complete({ system: "", messages: [], model: "" }),
    ).rejects.toThrow(/no canned result/);
  });
});
