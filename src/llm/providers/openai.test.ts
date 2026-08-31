import { describe, expect, test } from "bun:test";
import { OpenAIProvider } from "./openai";
import type { GenerationRequest } from "../types";

type PrivateResponsesBuilder = {
  buildResponsesBody(request: GenerationRequest): Record<string, unknown>;
};

// Shapes per openai/openai-node src/resources/responses/responses.ts
//   ResponseFunctionToolCall  : { type:"function_call", call_id, name, arguments:string }
//   FunctionCallOutput        : { type:"function_call_output", call_id, output:string }
// Regular message items: { role, content:[{type:"input_text"|"input_image"|...}] }
describe("OpenAIProvider Responses API tool calling wire shape", () => {
  test("tool_use part becomes a function_call input item", () => {
    const provider = new OpenAIProvider();
    const body = (provider as unknown as PrivateResponsesBuilder).buildResponsesBody({
      model: "gpt-5",
      messages: [
        { role: "user", content: "weather please" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Looking it up." },
            { type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "SF" } },
          ],
        },
      ],
      parameters: {},
    });

    expect(body.input).toEqual([
      { role: "user", content: "weather please" },
      { role: "assistant", content: [{ type: "input_text", text: "Looking it up." }] },
      {
        type: "function_call",
        call_id: "call_abc",
        name: "get_weather",
        arguments: JSON.stringify({ city: "SF" }),
      },
    ]);
  });

  test("tool_result part becomes a function_call_output input item", () => {
    const provider = new OpenAIProvider();
    const body = (provider as unknown as PrivateResponsesBuilder).buildResponsesBody({
      model: "gpt-5",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "72F" }],
        },
      ],
      parameters: {},
    });

    expect(body.input).toEqual([
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "72F" },
    ]);
  });

  test("assistant with only tool_use emits no message item", () => {
    const provider = new OpenAIProvider();
    const body = (provider as unknown as PrivateResponsesBuilder).buildResponsesBody({
      model: "gpt-5",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "ping", input: {} }],
        },
      ],
      parameters: {},
    });

    expect(body.input).toEqual([
      { role: "user", content: "x" },
      { type: "function_call", call_id: "call_1", name: "ping", arguments: "{}" },
    ]);
  });

  test("system messages extracted into instructions, not input", () => {
    const provider = new OpenAIProvider();
    const body = (provider as unknown as PrivateResponsesBuilder).buildResponsesBody({
      model: "gpt-5",
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi" },
      ],
      parameters: {},
    });

    expect(body.instructions).toBe("be nice");
    expect(body.input).toEqual([{ role: "user", content: "hi" }]);
  });

  test("passes ordinary Responses state and include parameters unchanged", () => {
    const provider = new OpenAIProvider();
    const body = (provider as unknown as PrivateResponsesBuilder).buildResponsesBody({
      model: "gpt-5",
      messages: [{ role: "user", content: "continue this request" }],
      parameters: {
        use_responses_api: true,
        store: true,
        previous_response_id: "resp_previous",
        conversation: "conversation_1",
        background: { mode: "auto" },
        include: ["message.output_text.logprobs"],
      },
    });

    expect(body.store).toBe(true);
    expect(body.previous_response_id).toBe("resp_previous");
    expect(body.conversation).toBe("conversation_1");
    expect(body.background).toEqual({ mode: "auto" });
    expect(body.include).toEqual(["message.output_text.logprobs"]);
  });
  test("adds host reasoning include for ordinary tool requests", () => {
    const provider = new OpenAIProvider();
    const body = (provider as unknown as PrivateResponsesBuilder).buildResponsesBody({
      model: "gpt-5",
      messages: [{ role: "user", content: "call host_tool" }],
      parameters: { use_responses_api: true },
      tools: [{
        name: "host_tool",
        description: "host tool",
        parameters: { type: "object" },
      }],
    });

    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("forces Agentic Responses requests to host-owned stateless reasoning", () => {
    const provider = new OpenAIProvider();
    const body = (provider as unknown as PrivateResponsesBuilder).buildResponsesBody({
      model: "gpt-5",
      messages: [{ role: "user", content: "call host_tool" }],
      parameters: {
        use_responses_api: true,
        store: true,
        previous_response_id: "resp_previous",
        conversation: "conversation_1",
        background: { mode: "auto" },
        include: ["message.output_text.logprobs"],
      },
      toolMode: "ordinary",
      tools: [{
        name: "host_tool",
        description: "host tool",
        parameters: { type: "object" },
      }],
    });

    expect(body.store).toBe(false);
    expect(body.previous_response_id).toBeUndefined();
    expect(body.conversation).toBeUndefined();
    expect(body.background).toBeUndefined();
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });
});

function responsesStream(
  events: readonly Record<string, unknown>[],
  includeDone = true,
): Response {
  const streamEvents = events[0]?.type === "response.created"
    ? events
    : [{ type: "response.created", response: { status: "in_progress" } }, ...events];
  const payload =
    streamEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    (includeDone ? "data: [DONE]\n\n" : "");
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OpenAI Responses terminal and transient carrier contracts", () => {
  test("accepts normal message/reasoning stream output and consumes trailing DONE", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      responsesStream([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "reasoning_1",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-carrier",
          },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            id: "message_1",
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning_1",
          delta: "plan",
        },
        {
          type: "response.output_text.delta",
          item_id: "message_1",
          delta: "hello",
        },
        {
          type: "response.content_part.done",
          item_id: "reasoning_1",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "reasoning_1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "plan" }],
            encrypted_content: "encrypted-carrier",
          },
        },
        {
          type: "response.content_part.done",
          item_id: "message_1",
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            id: "message_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "hello" }],
          },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: { input_tokens: 2, output_tokens: 1 },
          },
        },
      ])) as unknown as typeof fetch;
    try {
      const chunks = [];
      for await (const chunk of provider.generateStream("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        parameters: { use_responses_api: true },
      })) {
        chunks.push(chunk);
      }
      expect(chunks.map((chunk) => chunk.token).join("")).toBe("hello");
      expect(chunks.map((chunk) => chunk.reasoning ?? "").join("")).toBe("plan");
      expect(chunks.at(-1)?.finish_reason).toBe("stop");
      expect(chunks.at(-1)?.providerTransientCarrier?.kind).toBe("openai_responses");
      expect(chunks.at(-1)?.providerTransientCarrier?.items).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("coalesces indexed text and reasoning deltas before terminal reconciliation", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      responsesStream([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "reasoning_indexed", type: "reasoning", summary: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { id: "message_indexed", type: "message", role: "assistant", content: [] },
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning_indexed",
          summary_index: 0,
          delta: "rea",
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning_indexed",
          summary_index: 0,
          delta: "son",
        },
        {
          type: "response.output_text.delta",
          item_id: "message_indexed",
          content_index: 0,
          delta: "hel",
        },
        {
          type: "response.output_text.delta",
          item_id: "message_indexed",
          content_index: 0,
          delta: "lo",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "reasoning_indexed",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "reason" }],
          },
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            id: "message_indexed",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello" }],
          },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                id: "reasoning_indexed",
                type: "reasoning",
                summary: [{ type: "summary_text", text: "reason" }],
              },
              {
                id: "message_indexed",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "hello" }],
              },
            ],
          },
        },
      ])) as unknown as typeof fetch;
    try {
      const chunks = [];
      for await (const chunk of provider.generateStream("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        parameters: { use_responses_api: true },
      })) {
        chunks.push(chunk);
      }
      expect(chunks.map((chunk) => chunk.token).join("")).toBe("hello");
      expect(chunks.map((chunk) => chunk.reasoning ?? "").join("")).toBe("reason");
      expect(chunks.at(-1)?.providerTransientCarrier?.items).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("retains non-stream text-only output in the native carrier", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      status: "completed",
      output: [{
        id: "message_text_only",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }],
      }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })) as unknown as typeof fetch;
    try {
      const response = await provider.generate("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        parameters: { use_responses_api: true },
      });
      expect(response.tool_calls).toBeUndefined();
      expect(response.providerTransientCarrier?.items).toEqual([{
        id: "message_text_only",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }],
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  test("accepts semantic response.completed without a trailing DONE marker", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      responsesStream([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "message_2",
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        },
        {
          type: "response.output_text.delta",
          item_id: "message_2",
          delta: "done",
        },
        {
          type: "response.content_part.done",
          item_id: "message_2",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "message_2",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "done" }],
          },
        },
        { type: "response.completed", response: { status: "completed" } },
      ], false)) as unknown as typeof fetch;
    try {
      const chunks = [];
      for await (const chunk of provider.generateStream("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        parameters: { use_responses_api: true },
      })) {
        chunks.push(chunk);
      }
      expect(chunks.at(-1)?.finish_reason).toBe("stop");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects unsuccessful Responses status before exposing calls", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        status: "incomplete",
        output: [{
          type: "function_call",
          id: "function_item",
          call_id: "call_incomplete",
          name: "host_tool",
          arguments: "{}",
        }],
      })) as unknown as typeof fetch;
    try {
      await expect(provider.generate("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "call host_tool" }],
        toolMode: "ordinary",
        parameters: { use_responses_api: true },
      })).rejects.toThrow("did not complete successfully");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("returns ordinary non-stream partial Responses content and finish reason", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{
          id: "message_partial",
          type: "message",
          role: "assistant",
          status: "incomplete",
          content: [{ type: "output_text", text: "partial answer" }],
        }],
      })) as unknown as typeof fetch;
    try {
      const response = await provider.generate("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        parameters: { use_responses_api: true },
      });
      expect(response.content).toBe("partial answer");
      expect(response.finish_reason).toBe("max_output_tokens");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns ordinary streamed partial Responses content and finish reason", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      responsesStream([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "message_partial",
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        },
        {
          type: "response.output_text.delta",
          item_id: "message_partial",
          delta: "partial answer",
        },
        {
          type: "response.content_part.done",
          item_id: "message_partial",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "message_partial",
            type: "message",
            role: "assistant",
            status: "incomplete",
            content: [{ type: "output_text", text: "partial answer" }],
          },
        },
        {
          type: "response.completed",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ])) as unknown as typeof fetch;
    try {
      const chunks = [];
      for await (const chunk of provider.generateStream("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        parameters: { use_responses_api: true },
      })) {
        chunks.push(chunk);
      }
      expect(chunks.map((chunk) => chunk.token).join("")).toBe("partial answer");
      expect(chunks.at(-1)?.finish_reason).toBe("max_output_tokens");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects oversized Responses function arguments in non-stream responses", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    const oversizedArguments = "x".repeat(16 * 1024 + 1);
    globalThis.fetch = (async () =>
      Response.json({
        status: "completed",
        output: [{
          type: "function_call",
          id: "function_item",
          call_id: "call_oversized",
          name: "host_tool",
          arguments: oversizedArguments,
        }],
      })) as unknown as typeof fetch;
    try {
      await expect(provider.generate("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "call host_tool" }],
        parameters: { use_responses_api: true },
      })).rejects.toThrow("exceeded its bounded length");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects oversized Responses function arguments in response.completed output", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    const oversizedArguments = "x".repeat(16 * 1024 + 1);
    globalThis.fetch = (async () =>
      responsesStream([{
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "function_call",
            id: "function_item",
            call_id: "call_oversized",
            name: "host_tool",
            arguments: oversizedArguments,
          }],
        },
      }])) as unknown as typeof fetch;
    try {
      await expect((async () => {
        for await (const _chunk of provider.generateStream("key", "https://api.openai.com/v1", {
          model: "gpt-5",
          messages: [{ role: "user", content: "call host_tool" }],
          parameters: { use_responses_api: true },
        })) {
          // Consume the stream to force response.completed normalization.
        }
      })()).rejects.toThrow("exceeded its bounded length");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("replays bounded encrypted reasoning output items with function outputs only in memory", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    const responses = [
      Response.json({
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "reasoning_round_1",
            summary: [{ type: "summary_text", text: "plan" }],
            encrypted_content: "opaque-encrypted-carrier",
          },
          {
            type: "message",
            id: "message_round_1",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "lookup",
              annotations: [{
                type: "url_citation",
                url: "https://example.test/source",
                title: "source",
              }],
              logprobs: [{
                token: "lookup",
                logprob: -0.125,
                bytes: [108, 111, 111, 107, 117, 112],
                top_logprobs: [],
              }],
            }],
          },
          {
            type: "function_call",
            id: "function_round_1",
            call_id: "call_round_1",
            name: "host_tool",
            arguments: "{\"x\":1}",
          },
        ],
      }),
      Response.json({
        status: "completed",
        output: [{
          type: "message",
          id: "message_round_2",
          role: "assistant",
          content: [{ type: "output_text", text: "complete" }],
        }],
      }),
    ];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responses.shift() ?? Response.json({ status: "completed", output: [] });
    }) as unknown as typeof fetch;
    try {
      const first = await provider.generate("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "call host_tool" }],
        parameters: { use_responses_api: true },
        toolMode: "ordinary",
        tools: [{
          name: "host_tool",
          description: "host tool",
          parameters: { type: "object" },
        }],
      });
      expect(first.tool_calls?.[0]?.call_id).toBe("call_round_1");
      expect(first.content).toBe("lookup");
      expect(first.reasoning).toBe("plan");
      expect(bodies[0]!.include).toEqual(["reasoning.encrypted_content"]);
      expect(JSON.stringify(first)).not.toContain("opaque-encrypted-carrier");
      expect(JSON.stringify(first)).not.toContain("https://example.test/source");
      const carrier = first.providerTransientCarrier;
      expect(carrier?.kind).toBe("openai_responses");
      await provider.generate("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "call host_tool" }],
        parameters: { use_responses_api: true },
        providerTransientCarrier: {
          kind: "openai_responses",
          items: [
            ...carrier!.items,
            {
              type: "function_call_output",
              call_id: "call_round_1",
              output: "{\"ok\":true}",
            },
            {
              type: "message",
              role: "assistant",
              content: "unsigned assistant boundary",
            },
            {
              type: "message",
              role: "user",
              content: "host guidance",
            },
          ],
        },
      });
      const secondInput = bodies[1]!.input;
      expect(secondInput).toEqual([
        { role: "user", content: "call host_tool" },
        {
          type: "reasoning",
          id: "reasoning_round_1",
          summary: [{ type: "summary_text", text: "plan" }],
          encrypted_content: "opaque-encrypted-carrier",
        },
        {
          type: "message",
          id: "message_round_1",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "lookup",
            annotations: [{
              type: "url_citation",
              url: "https://example.test/source",
              title: "source",
            }],
            logprobs: [{
              token: "lookup",
              logprob: -0.125,
              bytes: [108, 111, 111, 107, 117, 112],
              top_logprobs: [],
            }],
          }],
        },
        {
          type: "function_call",
          id: "function_round_1",
          call_id: "call_round_1",
          name: "host_tool",
          arguments: "{\"x\":1}",
        },
        {
          type: "function_call_output",
          call_id: "call_round_1",
          output: "{\"ok\":true}",
        },
        {
          type: "message",
          role: "assistant",
          content: "unsigned assistant boundary",
        },
        {
          type: "message",
          role: "user",
          content: "host guidance",
        },
      ]);
      expect(bodies[1]!.include).toEqual(["reasoning.encrypted_content"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects payload after semantic completion while draining the stream", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      responsesStream([
        { type: "response.completed", response: { status: "completed" } },
        { type: "response.invalid_after_completion" },
      ])) as unknown as typeof fetch;
    try {
      await expect((async () => {
        for await (const _chunk of provider.generateStream("key", "https://api.openai.com/v1", {
          model: "gpt-5",
          messages: [{ role: "user", content: "hi" }],
          parameters: { use_responses_api: true },
        })) {
          // Consume the semantic terminal and force the iterator to drain.
        }
      })()).rejects.toThrow("emitted data after its terminal event");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("finalization mode suppresses parameter tool controls", () => {
    const provider = new OpenAIProvider();
    const body = (provider as unknown as {
      buildResponsesBody(request: unknown): Record<string, unknown>;
    }).buildResponsesBody({
      model: "gpt-5",
      messages: [{ role: "user", content: "finish" }],
      parameters: {
        use_responses_api: true,
        tools: [{ type: "computer_use_preview" }],
        tool_choice: "required",
        parallel_tool_calls: true,
        functions: [{ name: "attacker" }],
      },
      toolMode: "finalization",
      tools: [{
        name: "host_tool",
        description: "host tool",
        parameters: { type: "object" },
      }],
    });
    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBe("none");
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.functions).toBeUndefined();
  });

  test("Responses required mode selects some admitted host tool without naming one", () => {
    const provider = new OpenAIProvider();
    const body = (provider as unknown as {
      buildResponsesBody(request: unknown): Record<string, unknown>;
    }).buildResponsesBody({
      model: "gpt-5",
      messages: [{ role: "user", content: "continue" }],
      parameters: {
        use_responses_api: true,
        tool_choice: { type: "function", name: "attacker" },
        tools: [{ type: "computer_use_preview" }],
      },
      toolMode: "required",
      tools: [
        { name: "host_a", description: "A", parameters: { type: "object" } },
        { name: "host_b", description: "B", parameters: { type: "object" } },
      ],
    });
    expect(body.tool_choice).toBe("required");
    expect(body.tools).toEqual([
      { type: "function", name: "host_a", description: "A", parameters: { type: "object" }, strict: false },
      { type: "function", name: "host_b", description: "B", parameters: { type: "object" }, strict: false },
    ]);
  });
  test("rejects malformed non-stream Responses usage", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      status: "completed",
      output: [],
      usage: { input_tokens: "1", output_tokens: 1 },
    })) as unknown as typeof fetch;
    try {
      await expect(provider.generate("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        parameters: { use_responses_api: true },
      })).rejects.toThrow("finite nonnegative safe integer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects malformed streaming Responses usage", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => responsesStream([{
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 1, output_tokens: "1" },
      },
    }])) as unknown as typeof fetch;
    try {
      await expect((async () => {
        for await (const _chunk of provider.generateStream("key", "https://api.openai.com/v1", {
          model: "gpt-5",
          messages: [{ role: "user", content: "hi" }],
          parameters: { use_responses_api: true },
        })) {
          // Consume the terminal event.
        }
      })()).rejects.toThrow("finite nonnegative safe integer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects output text deltas without an item id", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => responsesStream([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "message_missing_id",
          type: "message",
          role: "assistant",
          content: [],
        },
      },
      { type: "response.output_text.delta", delta: "text" },
    ])) as unknown as typeof fetch;
    try {
      await expect((async () => {
        for await (const _chunk of provider.generateStream("key", "https://api.openai.com/v1", {
          model: "gpt-5",
          messages: [{ role: "user", content: "hi" }],
          parameters: { use_responses_api: true },
        })) {
          // The malformed delta must fail before it is yielded.
        }
      })()).rejects.toThrow("missing item_id");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects reasoning deltas for an unknown item", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => responsesStream([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "message_only",
          type: "message",
          role: "assistant",
          content: [],
        },
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "reasoning_unknown",
        delta: "plan",
      },
    ])) as unknown as typeof fetch;
    try {
      await expect((async () => {
        for await (const _chunk of provider.generateStream("key", "https://api.openai.com/v1", {
          model: "gpt-5",
          messages: [{ role: "user", content: "hi" }],
          parameters: { use_responses_api: true },
        })) {
          // The unknown item must fail before the delta is yielded.
        }
      })()).rejects.toThrow("unknown item");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects cumulative output text growth before the overflowing append", async () => {
    const provider = new OpenAIProvider();
    const carrierCap = 256 * 1024;
    const baseItem = {
      type: "message",
      id: "message_bound",
      role: "assistant",
      content: [],
    };
    const emptyPartBytes = Buffer.byteLength(JSON.stringify({ type: "output_text", text: "" }), "utf8");
    let carrierBytes = 2 + Buffer.byteLength(JSON.stringify({ ...baseItem, status: "in_progress" }), "utf8");
    const chunks: string[] = [];
    while (carrierBytes + emptyPartBytes + 4_096 <= carrierCap) {
      chunks.push("x".repeat(4_096));
      carrierBytes += emptyPartBytes + (chunks.length > 1 ? 1 : 0) + 4_096;
    }
    const finalLength = carrierCap - carrierBytes - emptyPartBytes - (chunks.length > 0 ? 1 : 0);
    expect(finalLength).toBeGreaterThan(0);
    chunks.push("x".repeat(finalLength));
    const events: Record<string, unknown>[] = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...baseItem, status: "in_progress" },
      },
      ...chunks.map((delta) => ({ type: "response.output_text.delta", item_id: baseItem.id, delta })),
      { type: "response.output_text.delta", item_id: baseItem.id, delta: "y" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => responsesStream(events)) as unknown as typeof fetch;
    let emitted = "";
    try {
      await expect((async () => {
        for await (const chunk of provider.generateStream("key", "https://api.openai.com/v1", {
          model: "gpt-5",
          messages: [{ role: "user", content: "hi" }],
          parameters: { use_responses_api: true },
        })) {
          emitted += chunk.token;
        }
      })()).rejects.toThrow("continuation carrier exceeded");
      expect(emitted).toBe(chunks.join(""));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("bounds Responses error bodies with the request receive cap", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("E".repeat(128), {
      status: 500,
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;
    try {
      const caught = await provider.generate("key", "https://api.openai.com/v1", {
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        parameters: { use_responses_api: true },
        receiveLimitBytes: 16,
      }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(Error);
      if (caught && typeof caught === "object" && "rawBody" in caught) {
        expect(caught.rawBody).toBe("E".repeat(16) + "…[truncated]");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
