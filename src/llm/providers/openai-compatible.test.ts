import type { GenerationRequest, StreamChunk } from "../types";
import { describe, expect, test } from "bun:test";
import {
  OpenAICompatibleProvider,
  ReasoningDetailsAccumulator,
} from "./openai-compatible";
import { OpenAIProvider } from "./openai";
import { DeepSeekProvider } from "./deepseek";
import { INVALID_TOOL_ARGUMENTS } from "../tool-arguments";
import { AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES } from "../../services/agent-runtime-accounting";
import {
  PROVIDER_STREAM_LIMITS,
  ProviderProtocolError,
  ProviderResponseTooLargeError,
} from "../stream-utils";

class TestOpenAICompatibleProvider extends OpenAICompatibleProvider {
  readonly name = "test";
  readonly displayName = "Test";
  readonly defaultUrl = "https://example.com";
  readonly capabilities = {
    parameters: {},
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: false,
    modelListStyle: "openai" as const,
    toolCalling: true,
    requiredToolChoice: true,
    nativeToolContinuation: false,
    toolContinuationMode: "legacy" as const,
    toolsDisabledFinalization: true,
    supportsToolFinalization: true,
  };

  constructor(requiredToolChoice = true) {
    super();
    this.capabilities = { ...this.capabilities, requiredToolChoice };
  }

  public inspect(content: unknown, reasoning: unknown) {
    return this.splitMirroredReasoning(content, reasoning);
  }

  public inspectBody(request: unknown): Record<string, unknown> {
    return this.buildBody(request as Parameters<OpenAICompatibleProvider["generate"]>[2], false);
  }
}
class TestDeepSeekProvider extends DeepSeekProvider {
  inspectBody(request: GenerationRequest): Record<string, unknown> {
    return this.buildBody(request, false) as Record<string, unknown>;
  }
}

describe("DeepSeek required tool mode", () => {
  const provider = new TestDeepSeekProvider();

  test("disables default thinking when the host requires an admitted tool", () => {
    const body = provider.inspectBody({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "continue" }],
      parameters: {},
      toolMode: "required",
      tools: [{ name: "complete_turn", description: "Complete", parameters: { type: "object" } }],
    });
    expect(body.tool_choice).toBe("required");
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});
describe("DeepSeek continuation thinking mode", () => {
  const provider = new TestDeepSeekProvider();

  test("keeps thinking disabled when a required-tool turn continues without a reasoning carrier", () => {
    const body = provider.inspectBody({
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.txt" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "contents" }],
        },
      ],
      parameters: {},
      tools: [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
    });

    expect(body.tool_choice).toBeUndefined();
    expect(body.thinking).toEqual({ type: "disabled" });
    expect((body.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty("reasoning_content");
  });

  test("preserves default thinking when every replayed tool call has its reasoning carrier", () => {
    const body = provider.inspectBody({
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.txt" } }],
          reasoning_content: "I need to read the file.",
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "contents" }],
        },
      ],
      parameters: {},
      tools: [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
    });

    expect(body.tool_choice).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect((body.messages as Array<Record<string, unknown>>)[1]?.reasoning_content).toBe("I need to read the file.");
  });
});

describe("OpenAI-compatible required tool mode", () => {
  const provider = new TestOpenAICompatibleProvider();

  test("requires an arbitrary admitted host tool and suppresses custom tool controls", () => {
    const body = provider.inspectBody({
      model: "test-model",
      messages: [{ role: "user", content: "continue" }],
      parameters: {
        tools: [{ type: "attacker" }],
        tool_choice: { type: "function", function: { name: "attacker" } },
        functions: [{ name: "attacker" }],
      },
      toolMode: "required",
      tools: [{ name: "host_a", description: "A", parameters: { type: "object" } }],
    });
    expect(body.tool_choice).toBe("required");
    expect(body.tools).toEqual([{
      type: "function",
      function: { name: "host_a", description: "A", parameters: { type: "object" }, strict: false },
    }]);
    expect(body.functions).toBeUndefined();
  });

  test("fails closed when no host tool was admitted", () => {
    expect(() => provider.inspectBody({
      model: "test-model",
      messages: [{ role: "user", content: "continue" }],
      toolMode: "required",
      tools: [],
    })).toThrow("at least one admitted host tool");
  });

  test("rejects unsupported required mode before constructing or sending a provider request", async () => {
    const unsupported = new TestOpenAICompatibleProvider(false);
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls += 1;
      throw new Error("provider must not be called");
    }) as unknown as typeof fetch;
    try {
      await expect(unsupported.generate("", "https://example.com", {
        model: "test-model",
        messages: [{ role: "user", content: "continue" }],
        toolMode: "required",
        tools: [{ name: "host_a", description: "A", parameters: { type: "object" } }],
      })).rejects.toThrow("does not support required tool choice");
      expect(providerCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenAICompatibleProvider reasoning mirroring", () => {
  const provider = new TestOpenAICompatibleProvider();

  test("drops content when it exactly mirrors reasoning", () => {
    expect(provider.inspect("planning", "planning")).toEqual({
      content: "",
      reasoning: "planning",
    });
  });

  test("drops content when it only differs by surrounding whitespace", () => {
    expect(provider.inspect("  planning\n", "planning")).toEqual({
      content: "",
      reasoning: "planning",
    });
  });

  test("preserves normal visible content when it differs from reasoning", () => {
    expect(provider.inspect("Answer", "planning")).toEqual({
      content: "Answer",
      reasoning: "planning",
    });
  });
});

describe("OpenAICompatibleProvider structured reasoning deltas", () => {
  const provider = new TestOpenAICompatibleProvider();

  test("coerces object reasoning deltas instead of aborting the stream", async () => {
    const originalFetch = globalThis.fetch;
    const events = [
      { choices: [{ delta: { reasoning: { text: "plan" } } }] },
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
    ];
    globalThis.fetch = (async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
    try {
      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.generateStream("key", "https://example.com/v1", {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        parameters: {},
      })) {
        chunks.push(chunk);
      }
      expect(chunks.map((chunk) => chunk.reasoning ?? "").join("")).toBe("plan");
      expect(chunks.map((chunk) => chunk.token).join("")).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenAICompatibleProvider streamed tool calls", () => {
  test("compacts non-contiguous provider tool-call indexes", async () => {
    const provider = new TestOpenAICompatibleProvider();
    const originalFetch = globalThis.fetch;
    const stream = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_1","function":{"name":"extract","arguments":"{\\"value\\":1}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ].join("\n\n") + "\n\ndata: [DONE]\n\n";

    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    try {
      const chunks = [];
      for await (const chunk of provider.generateStream("", "https://example.com", {
        model: "test",
        messages: [{ role: "user", content: "extract" }],
        parameters: {},
        tools: [],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.tool_calls).toEqual([
        { name: "extract", args: { value: 1 }, call_id: "call_1" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenAI reasoning_details incremental bounds", () => {
  const cap = AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES;

  test("charges the first field assignment and accepts the exact cap", () => {
    const fieldOverhead = Buffer.byteLength(JSON.stringify("text"), "utf8") + 1;
    const value = "x".repeat(cap - fieldOverhead);
    const accumulator = new ReasoningDetailsAccumulator();
    accumulator.push([{ index: 0, text: value }]);
    expect(accumulator.finalize()?.[0]?.text).toBe(value);
  });

  test("rejects cap plus one on the first field assignment", () => {
    const accumulator = new ReasoningDetailsAccumulator();
    expect(() => accumulator.push([{ index: 0, summary: "x".repeat(cap + 1) }]))
      .toThrow(ProviderResponseTooLargeError);
    expect(accumulator.finalize()).toEqual([]);
  });

  test("rejects cumulative append growth before storing the overflowing fragment", () => {
    const accumulator = new ReasoningDetailsAccumulator();
    accumulator.push([{ index: 0, data: "x".repeat(cap - 8) }]);
    accumulator.push([{ index: 0, data: "y" }]);
    expect(accumulator.finalize()?.[0]?.data).toBe("x".repeat(cap - 8) + "y");
    expect(() => accumulator.push([{ index: 0, data: "z".repeat(8) }]))
      .toThrow(ProviderResponseTooLargeError);
  });
  test("reserves plain reasoning at the exact cumulative cap", () => {
    const accumulator = new ReasoningDetailsAccumulator();
    expect(() => accumulator.reserveText("r".repeat(cap))).not.toThrow();
  });

  test("rejects plain reasoning at cumulative cap plus one before retention", () => {
    const accumulator = new ReasoningDetailsAccumulator();
    accumulator.reserveText("r".repeat(cap));
    expect(() => accumulator.reserveText("x")).toThrow(ProviderResponseTooLargeError);
  });

  test("ignores malformed reasoning_details without retaining them", () => {
    for (const malformed of [null, [null], [{ index: -1 }], [{ index: 1.5 }], [{ text: undefined }]]) {
      const accumulator = new ReasoningDetailsAccumulator();
      expect(() => accumulator.push(malformed)).not.toThrow();
      expect(accumulator.finalize()).toBeUndefined();
    }
  });

});

// Shapes per github.com/openai/openai-node ChatCompletionAssistantMessageParam +
// ChatCompletionToolMessageParam:
//   assistant: { role:"assistant", content?, tool_calls?:[{id,type:"function",function:{name,arguments:string}}] }
//   tool:      { role:"tool", tool_call_id, content:string|Array<TextPart> }
describe("OpenAICompatibleProvider tool calling wire shape", () => {
  const provider = new TestOpenAICompatibleProvider();

  test("assistant tool_use parts become tool_calls with stringified arguments", () => {
    const body = (provider as any).buildBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "weather please" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Looking it up." },
              { type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "SF" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_abc", content: "72F" },
            ],
          },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "Looking it up.",
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "get_weather", arguments: JSON.stringify({ city: "SF" }) },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_abc",
      content: "72F",
    });
  });

  test("assistant with only tool_use parts sets content to null", () => {
    const body = (provider as any).buildBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_1", name: "ping", input: {} },
            ],
          },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } },
      ],
    });
  });

  test("parallel tool_calls in one assistant message", () => {
    const body = (provider as any).buildBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_1", name: "a", input: { i: 1 } },
              { type: "tool_use", id: "call_2", name: "b", input: { i: 2 } },
            ],
          },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[1].tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "a", arguments: '{"i":1}' } },
      { id: "call_2", type: "function", function: { name: "b", arguments: '{"i":2}' } },
    ]);
  });

  test("multiple tool_results split into separate role:tool messages", () => {
    const body = (provider as any).buildBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "x" },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: "A" },
              { type: "tool_result", tool_use_id: "call_2", content: "B" },
            ],
          },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages.slice(1)).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "A" },
      { role: "tool", tool_call_id: "call_2", content: "B" },
    ]);
  });

  test("string-content messages still work alongside structured ones", () => {
    const body = (provider as any).buildBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "be nice" },
          { role: "user", content: "hi" },
        ],
        parameters: {},
      },
      false,
    );
    expect(body.messages).toEqual([
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
    ]);
  });
});

// DeepSeek thinking-mode (deepseek-reasoner, deepseek-chat with thinking
// enabled) requires the previous turn's reasoning_content to be echoed back
// on the assistant message when continuing a conversation that involved a
// tool call. Without this, the API rejects the request with:
//   "The `reasoning_content` in the thinking mode must be passed back to
//   the API." (deepseek 400 invalid_request_error)
// Tool-call continuations require the field. Retained prompt-history reasoning
// also stays on its original assistant turn, so replay is faithful even when a
// turn did not invoke a tool.
describe("OpenAICompatibleProvider reasoning_content roundtrip", () => {
  const provider = new TestOpenAICompatibleProvider();

  test("assistant + tool_use parts + reasoning_content → field on assistant body", () => {
    const body = (provider as any).buildBody(
      {
        model: "deepseek-reasoner",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_x", name: "lookup", input: { q: "SF" } },
            ],
            reasoning_content: "I should look up SF weather.",
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_x", content: "72F" },
            ],
          },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_x", type: "function", function: { name: "lookup", arguments: '{"q":"SF"}' } },
      ],
      reasoning_content: "I should look up SF weather.",
    });
  });

  test("assistant + tool_use without reasoning_content → field absent (no undefined / null pollution)", () => {
    const body = (provider as any).buildBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_1", name: "ping", input: {} },
            ],
          },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } },
      ],
    });
    expect("reasoning_content" in body.messages[1]).toBe(false);
  });

  test("assistant + text-only parts + reasoning_content → field on its assistant turn", () => {
    const body = (provider as any).buildBody(
      {
        model: "deepseek-reasoner",
        messages: [
          { role: "user", content: "what's 2+2?" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "The answer is 4." },
            ],
            reasoning_content: "2+2 is basic arithmetic; the answer is 4.",
          },
          { role: "user", content: "thanks" },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "The answer is 4." }],
      reasoning_content: "2+2 is basic arithmetic; the answer is 4.",
    });
  });

  test("user-role message with reasoning_content → field ignored (only assistant tool-call turns carry reasoning)", () => {
    // Defensive: reasoning_content on a non-assistant message is meaningless
    // and shouldn't leak into the request body — DeepSeek's API doesn't
    // accept reasoning_content on user/system messages.
    const body = (provider as any).buildBody(
      {
        model: "deepseek-reasoner",
        messages: [
          { role: "user", content: "hello", reasoning_content: "WRONG SHOULD NOT APPEAR" },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[0]).toEqual({ role: "user", content: "hello" });
    expect("reasoning_content" in body.messages[0]).toBe(false);
  });
});

function expectInvalidToolArguments(args: Record<string, unknown>): void {
  expect(Array.isArray(args)).toBe(true);
  if (!Array.isArray(args)) return;
  expect(args).toHaveLength(1);
  expect(args[0]).toBe("invalid_tool_arguments");
}

describe("OpenAI-compatible model-controlled tool argument parsing", () => {
  const provider = new TestOpenAICompatibleProvider();

  test("non-streaming malformed arguments reject before execution", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_bad",
                  function: { name: "lore_list_books", arguments: "not-json" },
                },
                {
                  id: "call_good",
                  function: { name: "lore_search_entries", arguments: '{"query":"x"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      await expect(provider.generate("key", "https://example.com/v1", {
        model: "test-model",
        messages: [{ role: "user", content: "search" }],
        parameters: {},
      })).rejects.toThrow("Provider tool arguments are not valid JSON");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("streaming malformed arguments drop only the incomplete call", async () => {
    const events = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_bad_stream",
              function: { name: "lore_list_books", arguments: "{" },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 1,
              id: "call_good_stream",
              function: { name: "lore_search_entries", arguments: '{"query":"x"}' },
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        { status: 200 },
      )) as unknown as typeof fetch;

    const chunks: StreamChunk[] = [];
    try {
      for await (const chunk of provider.generateStream("key", "https://example.com/v1", {
        model: "test-model",
        messages: [{ role: "user", content: "search" }],
        parameters: {},
      })) {
        chunks.push(chunk);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    const finish = chunks.find((chunk) => chunk.finish_reason);
    expect(finish?.finish_reason).toBe("tool_calls");
    expect(finish?.tool_calls).toEqual([
      { name: "lore_search_entries", args: { query: "x" }, call_id: "call_good_stream" },
    ]);
  });
});

describe("OpenAI-compatible stream-end tool call buffer", () => {
  const provider = new TestOpenAICompatibleProvider();
  const request = {
    model: "test-model",
    messages: [{ role: "user" as const, content: "search" }],
    parameters: {},
  };

  async function collectStream(events: unknown[]): Promise<StreamChunk[]> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
    try {
      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.generateStream("key", "https://example.com/v1", request)) {
        chunks.push(chunk);
      }
      return chunks;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("emits tool_calls when [DONE] arrives with a complete buffered call", async () => {
    const chunks = await collectStream([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_done_complete",
              function: { name: "ping", arguments: "{}" },
            }],
          },
        }],
      },
    ]);
    const finish = chunks.find((chunk) => chunk.finish_reason);
    expect(finish?.finish_reason).toBe("tool_calls");
    expect(finish?.tool_calls).toEqual([
      { name: "ping", args: {}, call_id: "call_done_complete" },
    ]);
  });

  test("finishes as stop when [DONE] arrives with an incomplete buffered call", async () => {
    const chunks = await collectStream([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_done_incomplete",
            }],
          },
        }],
      },
    ]);
    const finish = chunks.find((chunk) => chunk.finish_reason);
    expect(finish?.finish_reason).toBe("stop");
    expect(finish?.token).toBe("");
    expect(finish?.tool_calls).toBeUndefined();
  });

  test("accepts stop with a complete buffered call", async () => {
    const chunks = await collectStream([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_stop_complete",
              function: { name: "ping", arguments: '{"q":1}' },
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const finish = chunks.find((chunk) => chunk.finish_reason);
    expect(finish?.finish_reason).toBe("tool_calls");
    expect(finish?.tool_calls).toEqual([
      { name: "ping", args: { q: 1 }, call_id: "call_stop_complete" },
    ]);
  });

  test("finishes as stop when a named call has truncated arguments", async () => {
    const chunks = await collectStream([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_truncated_args",
              function: { name: "ping", arguments: '{"q":' },
            }],
          },
        }],
      },
    ]);
    const finish = chunks.find((chunk) => chunk.finish_reason);
    expect(finish?.finish_reason).toBe("stop");
    expect(finish?.tool_calls).toBeUndefined();
  });

  test("executes a complete sibling when another buffered call has truncated arguments", async () => {
    const chunks = await collectStream([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_truncated_sibling",
              function: { name: "ping", arguments: '{"q":' },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 1,
              id: "call_complete_sibling",
              function: { name: "pong", arguments: '{"ok":true}' },
            }],
          },
        }],
      },
    ]);
    const finish = chunks.find((chunk) => chunk.finish_reason);
    expect(finish?.finish_reason).toBe("tool_calls");
    expect(finish?.tool_calls).toEqual([
      { name: "pong", args: { ok: true }, call_id: "call_complete_sibling" },
    ]);
  });

  test("drops a missing-name call without discarding a complete sibling", async () => {
    const chunks = await collectStream([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_missing_name",
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 1,
              id: "call_named_sibling",
              function: { name: "ping", arguments: "{}" },
            }],
          },
        }],
      },
    ]);
    const finish = chunks.find((chunk) => chunk.finish_reason);
    expect(finish?.finish_reason).toBe("tool_calls");
    expect(finish?.tool_calls).toEqual([
      { name: "ping", args: {}, call_id: "call_named_sibling" },
    ]);
  });
});



describe("OpenAI-compatible usage and error receive contracts", () => {
  const provider = new TestOpenAICompatibleProvider();
  const request = {
    model: "test-model",
    messages: [{ role: "user" as const, content: "hello" }],
    parameters: {},
  };
  function chunkedResponse(bytes: Uint8Array, contentType: string): Response {
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.byteLength, offset + 32 * 1024);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    }), {
      status: 200,
      headers: { "content-type": contentType },
    });
  }

  test("rejects malformed non-stream usage instead of coercing it", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      choices: [{
        message: { content: "ok" },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: "1",
        completion_tokens: 1,
        total_tokens: 2,
      },
    })) as unknown as typeof fetch;
    try {
      await expect(provider.generate("key", "https://example.com/v1", request))
        .rejects.toThrow("finite nonnegative safe integer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("rejects present non-string buffered content and finish_reason", async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const payload of [
        { choices: [{ message: { content: { invalid: true } }, finish_reason: "stop" }] },
        { choices: [{ message: { content: "ok" }, finish_reason: { invalid: true } }] },
      ]) {
        globalThis.fetch = (async () => Response.json(payload)) as unknown as typeof fetch;
        await expect(provider.generate("key", "https://example.com/v1", request))
          .rejects.toBeInstanceOf(ProviderProtocolError);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects inconsistent Chat usage totals", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      choices: [{
        message: { content: "ok" },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 3,
      },
    })) as unknown as typeof fetch;
    try {
      await expect(provider.generate("key", "https://example.com/v1", request))
        .rejects.toThrow("total_tokens does not match");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects malformed streaming usage instead of coercing it", async () => {
    const originalFetch = globalThis.fetch;
    const events = [
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: "2",
        },
      },
    ];
    globalThis.fetch = (async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
    try {
      await expect((async () => {
        for await (const _chunk of provider.generateStream("key", "https://example.com/v1", request)) {
          // Consume until the malformed usage trailer.
        }
      })()).rejects.toThrow("finite nonnegative safe integer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("rejects present non-string streaming content and finish_reason", async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const event of [
        { choices: [{ delta: { content: { invalid: true } } }] },
        { choices: [{ delta: {}, finish_reason: { invalid: true } }] },
      ]) {
        globalThis.fetch = (async () => new Response(
          `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch;
        await expect((async () => {
          for await (const _chunk of provider.generateStream("key", "https://example.com/v1", request)) {
            // The malformed field must fail before any chunk is retained.
          }
        })()).rejects.toBeInstanceOf(ProviderProtocolError);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects cumulative streamed reasoning at carrier cap plus one", async () => {
    const originalFetch = globalThis.fetch;
    const half = Math.floor(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES / 2);
    const events = [
      { choices: [{ delta: { reasoning_content: "r".repeat(half) } }] },
      { choices: [{ delta: { reasoning_content: "x".repeat(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half + 1) } }] },
    ];
    globalThis.fetch = (async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
    try {
      await expect((async () => {
        for await (const _chunk of provider.generateStream("key", "https://example.com/v1", request)) {
          // The overflowing reasoning fragment must fail before it is yielded.
        }
      })()).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  test("bounds error bodies with the request receive cap", async () => {
    const originalFetch = globalThis.fetch;
    const body = "E".repeat(128);
    globalThis.fetch = (async () => new Response(body, {
      status: 500,
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;
    try {
      const error = await provider.generate("key", "https://example.com/v1", {
        ...request,
        receiveLimitBytes: 16,
      }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      if (error && typeof error === "object" && "rawBody" in error) {
        expect(error.rawBody).toBe("E".repeat(16) + "…[truncated]");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("clamps an oversized receive limit for chunked non-streaming responses", async () => {
    const originalFetch = globalThis.fetch;
    const host = PROVIDER_STREAM_LIMITS.maxResponseBytes;
    const body = new Uint8Array(host + 1);
    const fetchFixture = Object.assign(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        chunkedResponse(body, "application/json"),
      { preconnect: originalFetch.preconnect },
    ) satisfies typeof fetch;
    globalThis.fetch = fetchFixture;
    try {
      await expect(provider.generate("key", "https://example.com/v1", {
        ...request,
        receiveLimitBytes: host + 1,
      })).rejects.toMatchObject({
        code: "provider_response_too_large",
        limit: host,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("clamps an oversized receive limit for chunked streaming responses", async () => {
    const originalFetch = globalThis.fetch;
    const host = PROVIDER_STREAM_LIMITS.maxResponseBytes;
    const totalBytes = host + 1;
    const commentFrame = `:${"E".repeat(1022)}\n\n`;
    const fullFrameCount = Math.floor(totalBytes / commentFrame.length);
    const remainder = totalBytes % commentFrame.length;
    const trailingFrame = remainder === 0
      ? ""
      : remainder === 1
        ? "\n"
        : remainder === 2
          ? "\n\n"
          : `:${"E".repeat(remainder - 3)}\n\n`;
    const body = new TextEncoder().encode(
      commentFrame.repeat(fullFrameCount) + trailingFrame,
    );
    const fetchFixture = Object.assign(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        chunkedResponse(body, "text/event-stream"),
      { preconnect: originalFetch.preconnect },
    ) satisfies typeof fetch;
    globalThis.fetch = fetchFixture;
    try {
      await expect((async () => {
        for await (const _chunk of provider.generateStream("key", "https://example.com/v1", {
          ...request,
          receiveLimitBytes: host + 1,
        })) {
          // The bounded reader must fail before decoding this oversized body.
        }
      })()).rejects.toMatchObject({
        code: "provider_response_too_large",
        limit: host,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("accepts exactly one usage trailer after finish_reason", async () => {
    const originalFetch = globalThis.fetch;
    const events = [
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      {
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
    globalThis.fetch = (async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
    try {
      const chunks = [];
      for await (const chunk of provider.generateStream("key", "https://example.com/v1", request)) {
        chunks.push(chunk);
      }
      expect(chunks.map((chunk) => chunk.token).join("")).toBe("ok");
      expect(chunks.at(-1)?.usage).toEqual({
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        provider_raw: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects duplicate usage trailers after finish_reason", async () => {
    const originalFetch = globalThis.fetch;
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    const events = [
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage },
      { choices: [], usage },
    ];
    globalThis.fetch = (async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
    try {
      await expect((async () => {
        for await (const _chunk of provider.generateStream("key", "https://example.com/v1", request)) {
          // Consume until the duplicate trailer.
        }
      })()).rejects.toThrow("after finish_reason");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects text after finish_reason before it can be emitted", async () => {
    const originalFetch = globalThis.fetch;
    const events = [
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [{ delta: { content: "late" } }] },
    ];
    globalThis.fetch = (async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
    try {
      await expect((async () => {
        for await (const _chunk of provider.generateStream("key", "https://example.com/v1", request)) {
          // Consume until the post-finish content.
        }
      })()).rejects.toThrow("after finish_reason");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});

describe("OpenAI Responses API model-controlled tool argument parsing", () => {
  const provider = new OpenAIProvider();

  test("non-streaming malformed arguments reject before execution", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "function_call",
              id: "item_bad",
              name: "lore_list_books",
              arguments: "not-json",
              call_id: "response_bad",
            },
            {
              type: "function_call",
              id: "item_good",
              name: "lore_search_entries",
              arguments: '{"query":"x"}',
              call_id: "response_good",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      await expect(provider.generate("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "search" }],
        parameters: { use_responses_api: true },
      })).rejects.toThrow("Provider tool arguments are not valid JSON");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("streaming malformed arguments reject before execution", async () => {
    const events = [
      {
        type: "response.created",
        response: { status: "in_progress" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "item_bad",
          type: "function_call",
          name: "lore_list_books",
          call_id: "response_bad_stream",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_bad",
        delta: "not-json",
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "item_bad",
        arguments: "not-json",
      },

      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "item_good",
          type: "function_call",
          name: "lore_search_entries",
          call_id: "response_good_stream",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_good",
        delta: '{"query":"x"}',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "item_good",
        arguments: '{"query":"x"}',
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "item_bad",
          type: "function_call",
          name: "lore_list_books",
          call_id: "response_bad_stream",
          arguments: "not-json",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "item_good",
          type: "function_call",
          name: "lore_search_entries",
          call_id: "response_good_stream",
          arguments: '{"query":"x"}',
        },
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        { status: 200 },
      )) as unknown as typeof fetch;

    let caught: unknown;
    try {
      for await (const _chunk of provider.generateStream("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "search" }],
        parameters: { use_responses_api: true },
      })) {
        // The malformed first call must fail before a tool result can be consumed.
      }
    } catch (error) {
      caught = error;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(caught).toBeDefined();
    expect(String(caught)).toContain("Provider tool arguments are not valid JSON");
  });
});
