import { describe, expect, test } from "bun:test";
import type { StreamChunk } from "../types";
import { ProviderProtocolError, ProviderResponseTooLargeError, PROVIDER_STREAM_LIMITS } from "../stream-utils";
import { AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES } from "../../services/agent-runtime-accounting";
import { ProviderRequestError } from "../../utils/provider-errors";
import { INVALID_TOOL_ARGUMENTS } from "../tool-arguments";
import { GoogleProvider } from "./google";

// Shapes per googleapis/js-genai types.ts (Content, Part, FunctionCall,
// FunctionResponse). Content.role must be "user" or "model". FunctionCall is
// {name, args}. FunctionResponse is {name, response: Record<string, unknown>}
// where response uses "output"/"error" keys per the API docs.
describe("GoogleProvider tool calling wire shape", () => {
  test("required mode uses ANY over exactly the admitted host tools", () => {
    const body = (new GoogleProvider() as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "continue" }],
      parameters: {
        tools: [{ googleSearch: {} }],
        toolConfig: { functionCallingConfig: { mode: "NONE" } },
      },
      toolMode: "required",
      tools: [{ name: "host_a", description: "A", parameters: { type: "object" } }],
    });
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(body.tools).toEqual([{ functionDeclarations: [{
      name: "host_a",
      description: "A",
      parameters: { type: "object" },
    }] }]);
  });

  test("rejects required mode without an admitted function declaration", () => {
    expect(() => (new GoogleProvider() as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "continue" }],
      toolMode: "required",
      tools: [],
    })).toThrow("at least one admitted host tool");
  });

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

  test("hoists only the leading system prefix and preserves later placement", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        { role: "system", content: "prefix one" },
        { role: "system", content: "prefix two" },
        { role: "user", content: "old turn" },
        { role: "system", content: "depth instruction" },
        { role: "assistant", content: "reply" },
        { role: "system", content: "post-history instruction" },
      ],
      parameters: {},
      tools: [],
    });

    expect(body.systemInstruction).toEqual({
      parts: [{ text: "prefix one\n\nprefix two" }],
    });
    expect(body.contents.map((content: any) => [content.role, content.parts[0].text])).toEqual([
      ["user", "old turn"],
      ["user", "depth instruction"],
      ["model", "reply"],
      ["user", "post-history instruction"],
    ]);
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
    globalThis.fetch = (async () => new Response(JSON.stringify({
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
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

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

describe("GoogleProvider model-controlled tool argument parsing", () => {
  const responseBody = {
    candidates: [{
      content: {
        parts: [
          { functionCall: { name: "lore_list_books" } },
          { functionCall: { name: "lore_search_entries", args: { query: "x" } } },
        ],
      },
      finishReason: "STOP",
    }],
  };
  function expectInvalidToolArguments(args: Record<string, unknown>): void {
    const invalidArgs = args;
    expect(Array.isArray(invalidArgs)).toBe(true);
    if (!Array.isArray(invalidArgs)) return;
    expect(invalidArgs).toHaveLength(INVALID_TOOL_ARGUMENTS.length);
    expect(invalidArgs[0]).toBe(INVALID_TOOL_ARGUMENTS[0]);
  }

  test("non-streaming missing arguments reject before execution", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      await expect(new GoogleProvider().generate(
        "key",
        "https://generativelanguage.googleapis.com",
        {
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "search" }],
          parameters: {},
          tools: [
            { name: "lore_list_books", description: "", parameters: {} },
            { name: "lore_search_entries", description: "", parameters: {} },
          ],
        },
      )).rejects.toThrow("Provider tool arguments are missing or invalid");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("streaming missing arguments reject before execution", async () => {
    const originalFetch = globalThis.fetch;
    const sse = `data: ${JSON.stringify(responseBody)}\n\n`;
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200 })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      for await (const _chunk of new GoogleProvider().generateStream(
        "key",
        "https://generativelanguage.googleapis.com",
        {
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "search" }],
          parameters: {},
          tools: [
            { name: "lore_list_books", description: "", parameters: {} },
            { name: "lore_search_entries", description: "", parameters: {} },
          ],
        },
      )) {
        // Missing function-call arguments must fail before a tool result can be consumed.
      }
    } catch (error) {
      caught = error;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(caught).toBeDefined();
    expect(String(caught)).toContain("Gemini functionCall is missing arguments");
  });
});

describe("GoogleProvider bounded response protocol", () => {
  const baseRequest = {
    model: "gemini-2.5-flash",
    messages: [{ role: "user" as const, content: "hello" }],
    parameters: {},
    tools: [],
  };

  function sseResponse(payloads: readonly Record<string, unknown>[]): Response {
    const body = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  function mergedArgumentFragments(totalBytes: number): [{ first: string }, { second: string }] {
    const fixedBytes = Buffer.byteLength(JSON.stringify({ first: "", second: "" }), "utf8");
    return [{ first: "x".repeat(totalBytes - fixedBytes) }, { second: "" }];
  }

  async function consumeGoogleStream(request: typeof baseRequest): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = [];
    for await (const chunk of new GoogleProvider().generateStream("key", "https://generativelanguage.googleapis.com", request)) {
      chunks.push(chunk);
    }
    return chunks;
  }

  test("merged function-call arguments admit exact cap and reject cap plus one", async () => {
    const originalFetch = globalThis.fetch;
    const [exactFirst, exactSecond] = mergedArgumentFragments(PROVIDER_STREAM_LIMITS.maxArgumentsBytes);
    const exactSse = sseResponse([
      { candidates: [{ content: { parts: [{ functionCall: { id: "call-1", name: "merge", args: exactFirst } }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { id: "call-1", name: "merge", args: exactSecond } }] }, finishReason: "STOP" }] },
    ]);
    globalThis.fetch = (async () => exactSse) as unknown as typeof fetch;
    try {
      const chunks = await consumeGoogleStream(baseRequest);
      const toolCall = chunks.at(-1)?.tool_calls?.[0];
      expect(toolCall).toBeDefined();
      expect(Buffer.byteLength(JSON.stringify(toolCall?.args), "utf8")).toBe(PROVIDER_STREAM_LIMITS.maxArgumentsBytes);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const [overFirst, overSecond] = mergedArgumentFragments(PROVIDER_STREAM_LIMITS.maxArgumentsBytes + 1);
    const overSse = sseResponse([
      { candidates: [{ content: { parts: [{ functionCall: { id: "call-1", name: "merge", args: overFirst } }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { id: "call-1", name: "merge", args: overSecond } }] }, finishReason: "STOP" }] },
    ]);
    globalThis.fetch = (async () => overSse) as unknown as typeof fetch;
    try {
      await expect(consumeGoogleStream(baseRequest)).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("thought signatures use a cumulative carrier cap before assignment", async () => {
    const originalFetch = globalThis.fetch;
    const half = Math.floor(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES / 2);
    const exactBody = {
      candidates: [{
        content: {
          parts: [
            { functionCall: { id: "call-1", name: "one", args: {} }, thoughtSignature: "a".repeat(half) },
            { functionCall: { id: "call-2", name: "two", args: {} }, thoughtSignature: "b".repeat(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half) },
          ],
        },
        finishReason: "STOP",
      }],
    };
    globalThis.fetch = (async () => new Response(JSON.stringify(exactBody), { status: 200 })) as unknown as typeof fetch;
    try {
      const response = await new GoogleProvider().generate("key", "https://generativelanguage.googleapis.com", baseRequest);
      expect(response.tool_calls?.map((call) => call.thought_signature?.length)).toEqual([
        half,
        AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half,
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const overBody = {
      ...exactBody,
      candidates: [{
        ...exactBody.candidates[0],
        content: {
          parts: [
            { functionCall: { id: "call-1", name: "one", args: {} }, thoughtSignature: "a".repeat(half) },
            { functionCall: { id: "call-2", name: "two", args: {} }, thoughtSignature: "b".repeat(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half + 1) },
          ],
        },
      }],
    };
    globalThis.fetch = (async () => new Response(JSON.stringify(overBody), { status: 200 })) as unknown as typeof fetch;
    try {
      await expect(new GoogleProvider().generate("key", "https://generativelanguage.googleapis.com", baseRequest))
        .rejects.toBeInstanceOf(ProviderResponseTooLargeError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("reasoning text uses a cumulative carrier cap before append", async () => {
    const half = Math.floor(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES / 2);
    const exactBody = {
      candidates: [{
        content: {
          parts: [
            { thought: true, text: "a".repeat(half) },
            { thought: true, text: "b".repeat(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half) },
          ],
        },
        finishReason: "STOP",
      }],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(exactBody), { status: 200 })) as unknown as typeof fetch;
    try {
      const exact = await new GoogleProvider().generate("key", "https://generativelanguage.googleapis.com", baseRequest);
      expect(exact.reasoning?.length).toBe(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const overBody = {
      ...exactBody,
      candidates: [{
        ...exactBody.candidates[0],
        content: {
          parts: [
            { thought: true, text: "a".repeat(half) },
            { thought: true, text: "b".repeat(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half + 1) },
          ],
        },
      }],
    };
    globalThis.fetch = (async () => new Response(JSON.stringify(overBody), { status: 200 })) as unknown as typeof fetch;
    try {
      await expect(new GoogleProvider().generate("key", "https://generativelanguage.googleapis.com", baseRequest))
        .rejects.toBeInstanceOf(ProviderResponseTooLargeError);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const streamOver = sseResponse([
      { candidates: [{ content: { parts: [{ thought: true, text: "a".repeat(half) }] } }] },
      { candidates: [{ content: { parts: [{ thought: true, text: "b".repeat(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half + 1) }] }, finishReason: "STOP" }] },
    ]);
    globalThis.fetch = (async () => streamOver) as unknown as typeof fetch;
    try {
      await expect(consumeGoogleStream(baseRequest)).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  test("malformed usage metadata rejects in non-stream responses", async () => {
    const originalFetch = globalThis.fetch;
    const malformedBody = {
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1.5, candidatesTokenCount: 2, totalTokenCount: 3 },
    };
    globalThis.fetch = (async () => new Response(JSON.stringify(malformedBody), { status: 200 })) as unknown as typeof fetch;
    try {
      await expect(new GoogleProvider().generate("key", "https://generativelanguage.googleapis.com", baseRequest))
        .rejects.toBeInstanceOf(ProviderProtocolError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("malformed usage metadata rejects on any streaming chunk", async () => {
    const originalFetch = globalThis.fetch;
    const malformedSse = sseResponse([{
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: "2", totalTokenCount: 3 },
    }]);
    globalThis.fetch = (async () => malformedSse) as unknown as typeof fetch;
    try {
      await expect(consumeGoogleStream(baseRequest)).rejects.toBeInstanceOf(ProviderProtocolError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("thought signatures on non-call parts reject malformed protocol input", async () => {
    const originalFetch = globalThis.fetch;
    const malformedBody = {
      candidates: [{ content: { parts: [{ text: "ok", thoughtSignature: 123 }] }, finishReason: "STOP" }],
    };
    globalThis.fetch = (async () => new Response(JSON.stringify(malformedBody), { status: 200 })) as unknown as typeof fetch;
    try {
      await expect(new GoogleProvider().generate("key", "https://generativelanguage.googleapis.com", baseRequest))
        .rejects.toBeInstanceOf(ProviderProtocolError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("provider error reads honor the request receive cap", async () => {
    const originalFetch = globalThis.fetch;
    const tail = "tail-that-must-not-be-retained";
    globalThis.fetch = (async () => new Response(`{"error":{"message":"${"x".repeat(256)}${tail}"}}`, {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
    try {
      let caught: unknown;
      try {
        await new GoogleProvider().generate("key", "https://generativelanguage.googleapis.com", {
          ...baseRequest,
          receiveLimitBytes: 32,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProviderRequestError);
      if (!(caught instanceof ProviderRequestError)) return;
      expect(caught.rawBody).not.toContain(tail);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("provider error reads honor request abort", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const pullStarted = Promise.withResolvers<void>();
    let releasePull: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("partial error"));
      },
      pull() {
        pullStarted.resolve();
        return new Promise<void>((resolve) => {
          releasePull = resolve;
        });
      },
      cancel() {
        releasePull?.();
      },
    });
    globalThis.fetch = (async () => new Response(body, { status: 503 })) as unknown as typeof fetch;
    try {
      const pending = new GoogleProvider().generate("key", "https://generativelanguage.googleapis.com", {
        ...baseRequest,
        signal: controller.signal,
      });
      await pullStarted.promise;
      controller.abort(new DOMException("stop", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      releasePull?.();
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
