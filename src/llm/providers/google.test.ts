import { describe, expect, test } from "bun:test";
import { GoogleProvider } from "./google";

// Shapes per googleapis/js-genai types.ts (Content, Part, FunctionCall,
// FunctionResponse). Content.role must be "user" or "model". FunctionCall is
// {name, args}. FunctionResponse is {name, response: Record<string, unknown>}
// where response uses "output"/"error" keys per the API docs.
describe("GoogleProvider tool calling wire shape", () => {
  test("tool_use part becomes a functionCall part on a model-role Content", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        { role: "user", content: "weather please" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Looking it up." },
            { type: "tool_use", id: "fc_1", name: "get_weather", input: { city: "SF" } },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1]).toEqual({
      role: "model",
      parts: [
        { text: "Looking it up." },
        { functionCall: { name: "get_weather", args: { city: "SF" } }, thoughtSignature: "context_engineering_is_the_way_to_go" },
      ],
    });
  });

  test("captured thought_signature is echoed verbatim on the functionCall", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-3-flash",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "fc_1", name: "get_weather", input: { city: "SF" }, thought_signature: "REAL_SIG_A" },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1].parts[0]).toEqual({
      functionCall: { name: "get_weather", args: { city: "SF" } },
      thoughtSignature: "REAL_SIG_A",
    });
  });

  test("replays an optional non-tool thought signature only when enabled", () => {
    const provider = new GoogleProvider();
    const request = {
      model: "gemini-3-flash",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "I checked the details.", thought_signature: "TEXT_SIG_A" },
      ],
    };

    const enabled = (provider as any).buildBody({
      ...request,
      parameters: { _replay_thought_signatures: true },
    });
    expect(enabled.contents[1].parts[0]).toEqual({
      text: "I checked the details.",
      thoughtSignature: "TEXT_SIG_A",
    });

    const disabled = (provider as any).buildBody({ ...request, parameters: {} });
    expect(disabled.contents[1].parts[0].thoughtSignature).toBe(
      "context_engineering_is_the_way_to_go",
    );
  });

  test("tool_result part becomes a functionResponse with output key", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "fc_1", name: "get_weather", input: { city: "SF" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "fc_1", content: "72F" },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "get_weather", response: { output: "72F" } } },
      ],
    });
  });

  test("tool_result with is_error uses error key", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "fc_1", name: "get_weather", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "fc_1", content: "boom", is_error: true },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1].parts[0]).toEqual({
      functionResponse: { name: "get_weather", response: { error: "boom" } },
    });
  });

  test("functionResponse name is resolved from prior functionCall via tool_use_id", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "fc_1", name: "first", input: {} },
            { type: "tool_use", id: "fc_2", name: "second", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "fc_2", content: "B" },
            { type: "tool_result", tool_use_id: "fc_1", content: "A" },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1].parts).toEqual([
      { functionResponse: { name: "second", response: { output: "B" } } },
      { functionResponse: { name: "first", response: { output: "A" } } },
    ]);
  });

  test("JSON-shaped tool result is parsed and wrapped under output", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "fc_1", name: "lookup", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "fc_1", content: '{"temp":72,"unit":"F"}' },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1].parts[0]).toEqual({
      functionResponse: { name: "lookup", response: { output: { temp: 72, unit: "F" } } },
    });
  });

  test("string-only messages still serialize as { text } parts", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi" },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
    ]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "be nice" }] });
  });
});

describe("GoogleProvider web search grounding", () => {
  test.each(["googleSearch", "google_search", "enable_web_search"])(
    "adds google_search for the %s parameter",
    (parameter) => {
      const provider = new GoogleProvider();
      const body = (provider as any).buildBody({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "What's new today?" }],
        parameters: { [parameter]: true },
        tools: [],
      });

      expect(body.tools).toEqual([{ google_search: {} }]);
      expect(body.googleSearch).toBeUndefined();
      expect(body.google_search).toBeUndefined();
      expect(body.enable_web_search).toBeUndefined();
    },
  );

  test("does not combine google_search with inline function declarations", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Hi" }],
      parameters: { enable_web_search: true },
      tools: [{ name: "lookup", description: "Lookup", parameters: {} }],
    });

    expect(body.tools).toEqual([{
      functionDeclarations: [{ name: "lookup", description: "Lookup", parameters: {} }],
    }]);
  });

  test("skips unsupported Lite models", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.0-flash-lite",
      messages: [{ role: "user", content: "Hi" }],
      parameters: { enable_web_search: true },
      tools: [],
    });

    expect(body.tools).toBeUndefined();
  });

  test("does not duplicate an existing custom-body google_search tool", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Hi" }],
      parameters: {
        enable_web_search: true,
        tools: [{ google_search: {} }],
      },
      tools: [],
    });

    expect(body.tools).toEqual([{ google_search: {} }]);
  });

  test("uses conditional dynamic retrieval only when a threshold is supplied", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Latest news" }],
      parameters: { googleSearch: true, googleSearchDynamicThreshold: 0.3 },
      tools: [],
    });

    expect(body.tools).toEqual([{
      googleSearch: { dynamicRetrievalConfig: { dynamicThreshold: 0.3 } },
    }]);
    expect(provider.capabilities.parameters.googleSearchDynamicThreshold.default).toBeUndefined();
  });

  test("preserves response grounding metadata in provider usage", async () => {
    const groundingMetadata = {
      webSearchQueries: ["latest news"],
      groundingChunks: [{ web: { uri: "https://example.com/news", title: "News" } }],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: "An update." }] },
          finishReason: "STOP",
          groundingMetadata,
        }],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 2,
          totalTokenCount: 6,
        },
      }),
    })) as any;

    try {
      const provider = new GoogleProvider();
      const result = await provider.generate(
        "key",
        "https://generativelanguage.googleapis.com",
        {
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "Latest news" }],
          parameters: { enable_web_search: true },
          tools: [],
        },
      );

      expect(result.usage?.provider_raw?.groundingMetadata).toEqual(groundingMetadata);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GoogleProvider streaming", () => {
  test("waits for stream close before emitting STOP from a multi-envelope Gemini response", async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: unknown[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response([
        'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":0,"totalTokenCount":0}}\n\n',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Lumiverse Gemini test passed"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":0,"totalTokenCount":0}}\n\n',
        'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":5,"totalTokenCount":168}}\n\n',
      ].join(""), { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const provider = new GoogleProvider();
      const chunks = [];
      for await (const chunk of provider.generateStream("test-key", "https://provider.example.test", {
        model: "test-model",
        messages: [{ role: "user", content: "Reply with exactly: Lumiverse Gemini test passed" }],
        parameters: {
          temperature: 1,
          max_tokens: 128,
          thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
        },
      })) {
        chunks.push(chunk);
      }

      expect(requestBodies[0]).toMatchObject({
        generationConfig: {
          temperature: 1,
          maxOutputTokens: 128,
          thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
        },
      });
      expect(chunks).toEqual([
        {
          token: "",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
        {
          token: "Lumiverse Gemini test passed",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
        {
          token: "",
          usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 168 },
        },
        {
          token: "",
          finish_reason: "stop",
          usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 168 },
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
