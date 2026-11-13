import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { AnthropicProvider } from "./anthropic";
import type { LlmThinkingBlock, StreamChunk } from "../types";

describe("AnthropicProvider thinking config", () => {
  for (const model of ["claude-fable-5", "claude-fable-5-1", "claude-sonnet-5"]) {
    test(`preserves effort with implicit thinking for ${model}`, () => {
      const body = (new AnthropicProvider() as any).buildBody({
        model,
        messages: [{ role: "user", content: "hi" }],
        parameters: { output_config: { effort: "low" } },
      }, true);
      expect(body.output_config).toEqual({ effort: "low" });
      expect(body.thinking).toBeUndefined();
    });
  }
  test("sends the minimal disabled thinking payload", () => {
    const provider = new AnthropicProvider();

    const body = (provider as any).buildBody(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        parameters: {
          max_tokens: 256,
          thinking: {
            type: "disabled",
            display: "summarized",
            budget_tokens: 4096,
          },
          output_config: {
            effort: "max",
            format: { type: "json_schema", name: "Example", schema: {} },
          },
        },
      },
      false,
    );

    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toEqual({
      format: { type: "json_schema", name: "Example", schema: {} },
    });
  });

  for (const model of [
    "claude-opus-5-20260813",
    "claude-opus-5-5",
    "claude-opus-5.5",
    "claude-sonnet-5-20260813",
    "claude-fable-5-20260813",
    "claude-future-family-5.1",
  ]) {
    test(`omits manual sampling params for ${model}`, () => {
      const provider = new AnthropicProvider();

      const body = (provider as any).buildBody(
        {
          model,
          messages: [{ role: "user", content: "hi" }],
          parameters: {
            max_tokens: 256,
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
          },
        },
        false,
      );

      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
      expect(body).not.toHaveProperty("top_k");
      expect(body.thinking).toEqual({ type: "adaptive" });
      expect(body.output_config).toEqual({ effort: "high" });
    });
  }
});

describe("Anthropic stream completion and errors", () => {
  const provider = new AnthropicProvider();
  const request = { model: "claude-fable-5-1", messages: [{ role: "user" as const, content: "hi" }] };
  const thinking = [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "A thought." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque" } },
    { type: "content_block_stop", index: 0 },
  ];
  const stop = { type: "message_stop" };
  const terminal = (reason = "end_turn", details?: unknown) => ({
    type: "message_delta", delta: { stop_reason: reason, stop_details: details, stop_sequence: null }, usage: { output_tokens: 20 },
  });
  const encode = (events: object[]) => events.map(e => `event: ${(e as any).type}\r\ndata:${JSON.stringify(e)}\r\n\r\n`).join("");
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => { fetchSpy?.mockRestore(); });

  function mockStream(events: object[], trailing = "") {
    const bytes = new TextEncoder().encode(encode(events) + trailing);
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    })));
  }
  async function collect(chunks: StreamChunk[] = []) {
    for await (const chunk of provider.generateStream("test", "https://example.test", request)) chunks.push(chunk);
    return chunks;
  }

  test("streams thinking then text across byte boundaries, pings, and usage updates", async () => {
    mockStream([
      ...thinking, { type: "ping" }, { type: "future_event" },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello 🌍" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: {}, usage: { output_tokens: 12, cache_read_input_tokens: 4 } },
      terminal(),
      { type: "message_delta", delta: {}, usage: { output_tokens: 22 } },
    ], 'data:{"type":"message_stop"}');
    const chunks = await collect();
    expect(chunks.map(c => c.token).join("")).toBe("Hello 🌍");
    expect(chunks.map(c => c.reasoning || "").join("")).toBe("A thought.");
    expect(chunks.at(-1)).toMatchObject({
      finish_reason: "end_turn", stop_sequence: null,
      thinking_blocks: [{ type: "thinking", thinking: "A thought.", signature: "opaque" }],
      usage: { prompt_tokens: 14, completion_tokens: 22, total_tokens: 36, provider_raw: { output_tokens: 22, cache_read_input_tokens: 4 } },
    });
  });

  test("keeps signed and redacted thinking blocks, in order, on the tool-call terminal chunk", async () => {
    mockStream([
      ...thinking,
      { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "encrypted-reasoning" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city":"SF"}' } },
      { type: "content_block_stop", index: 2 },
      terminal("tool_use"), stop,
    ]);
    const final = (await collect()).at(-1);
    expect(final).toMatchObject({ finish_reason: "tool_calls", tool_calls: [{ name: "lookup", args: { city: "SF" }, call_id: "toolu_1" }] });
    expect(final?.thinking_blocks).toEqual([
      { type: "thinking", thinking: "A thought.", signature: "opaque" },
      { type: "redacted_thinking", data: "encrypted-reasoning" },
    ]);
  });

  test("waits for message_stop and closes the stream before publishing completion", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(c) { controller = c; c.enqueue(new TextEncoder().encode(encode([terminal()]))); },
      cancel() { cancelled = true; },
    })));
    const iter = provider.generateStream("test", "https://example.test", request);
    let resolved = false;
    const next = iter.next().then(value => { resolved = true; return value; });
    await Bun.sleep(5);
    expect(resolved).toBe(false);
    controller.enqueue(new TextEncoder().encode(encode([stop])));
    expect((await next).value).toMatchObject({ finish_reason: "end_turn" });
    expect(cancelled).toBe(true);
    await iter.return();
  });

  for (const withFinishReason of [false, true]) {
    test(`rejects premature EOF ${withFinishReason ? "after the stop reason" : "after reasoning"}`, async () => {
      mockStream([...thinking, ...(withFinishReason ? [terminal()] : [])]);
      const chunks: StreamChunk[] = [];
      await expect(collect(chunks)).rejects.toMatchObject({ code: "incomplete_stream", retryable: true });
      expect(chunks.some(c => c.reasoning)).toBe(true);
      expect(chunks.some(c => c.finish_reason)).toBe(false);
    });
  }

  test("propagates an overloaded_error inside an HTTP 200 stream", async () => {
    mockStream([...thinking, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]);
    const chunks: StreamChunk[] = [];
    await expect(collect(chunks)).rejects.toMatchObject({
      name: "ProviderRequestError", code: "overloaded_error", detail: "Overloaded", retryable: true,
    });
    expect(chunks.some(c => c.reasoning)).toBe(true);
    expect(chunks.some(c => c.finish_reason)).toBe(false);
  });

  test("does not classify permanent stream errors as retryable", async () => {
    mockStream([{ type: "error", error: { type: "invalid_request_error", message: "Invalid request" } }]);
    await expect(collect()).rejects.toMatchObject({ code: "invalid_request_error", retryable: false });
  });

  test("rejects message_stop without a stop reason", async () => {
    mockStream([...thinking, stop]);
    await expect(collect()).rejects.toMatchObject({ code: "incomplete_stream" });
  });

  test("does not swallow malformed JSON events", async () => {
    mockStream(thinking, 'data: {invalid}\n\n');
    await expect(collect()).rejects.toMatchObject({ code: "invalid_stream_event" });
  });

  for (const category of ["general_harms", null]) {
    test(`preserves refusal details with category ${category}`, async () => {
      const details = { type: "refusal", category, explanation: category ? "Request declined." : null };
      mockStream([...thinking, terminal("refusal", details), stop]);
      const chunks = await collect();
      expect(chunks.at(-1)).toMatchObject({ finish_reason: "refusal", stop_details: details });
    });
  }

  test("preserves max_tokens when there is no visible answer", async () => {
    mockStream([...thinking, terminal("max_tokens"), stop]);
    const chunks = await collect();
    expect(chunks.map(c => c.token).join("")).toBe("");
    expect(chunks.at(-1)?.finish_reason).toBe("max_tokens");
  });

  test("an abort while waiting for message_stop stays a cancellation", async () => {
    const abort = new AbortController();
    let cancelled = false;
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(encode(thinking))); },
      cancel() { cancelled = true; },
    })));
    const iter = provider.generateStream("test", "https://example.test", { ...request, signal: abort.signal });
    expect((await iter.next()).value).toMatchObject({ reasoning: "A thought." });
    const next = iter.next();
    abort.abort();
    expect((await next).done).toBe(true);
    expect(cancelled).toBe(true);
  });

  test("non-streaming refusals preserve details and are not masked by tool blocks", async () => {
    const details = { type: "refusal", category: null, explanation: null };
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      content: [{ type: "tool_use", id: "tool_1", name: "lookup", input: {} }],
      stop_reason: "refusal", stop_details: details, stop_sequence: null,
    }));
    expect(await provider.generate("test", "https://example.test", request)).toMatchObject({
      finish_reason: "refusal", stop_details: details, stop_sequence: null,
    });
  });
});

describe("AnthropicProvider caching config", () => {
  test("requires explicit enabling for caching", () => {
    const provider = new AnthropicProvider();

    const body = (provider as any).buildBody(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        parameters: {
          max_tokens: 256,
        },
      },
      false,
    );

    expect(body.cache_control).toBeUndefined();
  });

  test("can explicitly enable caching", () => {
    const provider = new AnthropicProvider();

    const body = (provider as any).buildBody(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        parameters: {
          max_tokens: 256,
          prompt_caching: true,
        },
      },
      false,
    );

    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  test("supports 1-hour top-level cache ttl", () => {
    const provider = new AnthropicProvider();

    const body = (provider as any).buildBody(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        parameters: {
          max_tokens: 256,
          prompt_caching: { type: "ephemeral", ttl: "1h" },
        },
      },
      false,
    );

    expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("preserves explicit cache breakpoints on system, messages, and tools", () => {
    const provider = new AnthropicProvider();

    const body = (provider as any).buildBody(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "system",
            content: "Stable system prefix",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
          {
            role: "user",
            content: "Stable user prefix",
            cache_control: { type: "ephemeral" },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Tool response context", cache_control: { type: "ephemeral" } }],
          },
        ],
        tools: [
          {
            name: "lookup",
            description: "Lookup data",
            parameters: { type: "object", properties: {} },
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
        parameters: {
          max_tokens: 256,
        },
      },
      false,
    );

    expect(body.system).toEqual([
      { type: "text", text: "Stable system prefix", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(body.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Stable user prefix", cache_control: { type: "ephemeral" } }],
    });
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Tool response context", cache_control: { type: "ephemeral" } }],
    });
    expect(body.tools).toEqual([
      {
        name: "lookup",
        description: "Lookup data",
        input_schema: { type: "object", properties: {} },
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });
});

describe("AnthropicProvider usage mapping", () => {
  test("keeps raw cache usage fields", async () => {
    const provider = new AnthropicProvider();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 30,
            cache_creation: {
              ephemeral_5m_input_tokens: 25,
              ephemeral_1h_input_tokens: 5,
            },
            output_tokens: 40,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      const response = await provider.generate("key", "", {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        parameters: { max_tokens: 256 },
      });

      expect(response.usage).toEqual({
        prompt_tokens: 60,
        completion_tokens: 40,
        total_tokens: 100,
        provider_raw: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_creation: {
            ephemeral_5m_input_tokens: 25,
            ephemeral_1h_input_tokens: 5,
          },
          output_tokens: 40,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Shapes per https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
//   assistant: { type:"tool_use", id, name, input }
//   user:      { type:"tool_result", tool_use_id, content, is_error? }
describe("AnthropicProvider tool_use / tool_result wire shape", () => {
  test("assistant tool_use parts pass through verbatim", () => {
    const provider = new AnthropicProvider();
    const body = (provider as any).buildBody(
      {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "weather please" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Looking it up." },
              { type: "tool_use", id: "toolu_01abc", name: "get_weather", input: { city: "SF" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_01abc", content: "72F" },
            ],
          },
        ],
        parameters: { max_tokens: 256 },
      },
      false,
    );

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Looking it up." },
        { type: "tool_use", id: "toolu_01abc", name: "get_weather", input: { city: "SF" } },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01abc", content: "72F" },
      ],
    });
  });

  test("assistant thinking blocks are sent back first, with signatures and redacted data unchanged", () => {
    const provider = new AnthropicProvider();
    const thinkingBlocks: LlmThinkingBlock[] = [
      { type: "thinking", thinking: "Look it up.", signature: "opaque-signature" },
      { type: "redacted_thinking", data: "encrypted-reasoning" },
    ];
    const body = provider["buildBody"](
      {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "weather please" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_01abc", name: "get_weather", input: { city: "SF" } }],
            thinking_blocks: thinkingBlocks,
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01abc", content: "72F" }] },
        ],
        parameters: { max_tokens: 256 },
      },
      false,
    );

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        ...thinkingBlocks,
        { type: "tool_use", id: "toolu_01abc", name: "get_weather", input: { city: "SF" } },
      ],
    });
  });

  test("tool_result with is_error sets the flag", () => {
    const provider = new AnthropicProvider();
    const body = (provider as any).buildBody(
      {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_99", name: "ping", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_99", content: "boom", is_error: true },
            ],
          },
        ],
        parameters: { max_tokens: 16 },
      },
      false,
    );

    const trBlock = body.messages[2].content.find((b: any) => b.type === "tool_result");
    expect(trBlock).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_99",
      content: "boom",
      is_error: true,
    });
  });

  test("tool_result without is_error omits the flag", () => {
    const provider = new AnthropicProvider();
    const body = (provider as any).buildBody(
      {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_99", name: "ping", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_99", content: "ok" },
            ],
          },
        ],
        parameters: { max_tokens: 16 },
      },
      false,
    );

    const trBlock = body.messages[2].content.find((b: any) => b.type === "tool_result");
    expect(trBlock).toBeDefined();
    expect(trBlock.tool_use_id).toBe("toolu_99");
    expect(trBlock.is_error).toBeUndefined();
  });
});
