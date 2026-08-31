import { describe, expect, test } from "bun:test";

import { AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES } from "../../services/agent-runtime-accounting";
import { ProviderRequestError } from "../../utils/provider-errors";
import { AnthropicProvider } from "./anthropic";
import { INVALID_TOOL_ARGUMENTS } from "../tool-arguments";
import {
  ProviderProtocolError,
  ProviderResponseTooLargeError,
} from "../stream-utils";
import type { LlmMessage, StreamChunk } from "../types";

describe("AnthropicProvider thinking config", () => {
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

class ExposedAnthropicProvider extends AnthropicProvider {
  exposeFormatContent(message: LlmMessage, suppressThinking = false) {
    return this.formatContent(message, suppressThinking);
  }
}

describe("AnthropicProvider required tool mode", () => {
  test("uses provider-neutral any-tool selection over exactly the admitted tools", () => {
    const body = (new AnthropicProvider() as any).buildBody({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "continue" }],
      parameters: {
        tool_choice: { type: "tool", name: "attacker" },
        tools: [{ name: "attacker" }],
      },
      toolMode: "required",
      tools: [{ name: "host_a", description: "A", parameters: { type: "object" } }],
    });
    expect(body.tool_choice).toEqual({ type: "any" });
    expect(body.tools).toEqual([{
      name: "host_a",
      description: "A",
      input_schema: { type: "object" },
      strict: false,
    }]);
  });

  test("rejects required mode without an admitted tool", () => {
    expect(() => (new AnthropicProvider() as any).buildBody({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "continue" }],
      toolMode: "required",
      tools: [],
    })).toThrow("at least one admitted host tool");
  });
});

describe("AnthropicProvider thinking carrier replay", () => {
  test("preserves an explicitly empty signature field", () => {
    const provider = new ExposedAnthropicProvider();
    expect(provider.exposeFormatContent({
      role: "assistant",
      content: "",
      thinking_blocks: [{ type: "thinking", thinking: "", signature: "" }],
    })).toEqual([
      { type: "thinking", thinking: "", signature: "" },
    ]);
  });
  test("preserves ordinary answer prefixes during active-thinking replay", () => {
    const provider = new ExposedAnthropicProvider();
    expect(provider.exposeFormatContent({
      role: "assistant",
      content: "ok, continuing",
      thinking_blocks: [{ type: "thinking", thinking: "plan: ok", signature: "sig" }],
    })).toEqual([
      { type: "thinking", thinking: "plan: ok", signature: "sig" },
      { type: "text", text: "ok, continuing" },
    ]);
  });
  test("deduplicates only cloneable suppressed structured continuations", () => {
    const provider = new ExposedAnthropicProvider();
    const activeBody = (provider as any).buildBody({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "ok, continuing" },
            { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
          ],
          reasoning_content: "plan: ok",
          thinking_blocks: [{ type: "thinking", thinking: "plan: ok", signature: "sig" }],
        },
      ],
      parameters: { max_tokens: 256, thinking: { type: "disabled" } },
    }, false);
    expect(activeBody.messages[1].content).toEqual([
      { type: "thinking", thinking: "plan: ok", signature: "sig" },
      { type: "text", text: "ok, continuing" },
      { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
    ]);

    const suppressedMessage = JSON.parse(JSON.stringify({
      role: "assistant",
      content: [
        { type: "text", text: "seedanswer" },
        { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
      ],
      thinking_blocks: [{ type: "thinking", thinking: "seed", signature: "sig", display_suppressed: true }],
    }));
    const suppressedBody = (provider as any).buildBody({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }, suppressedMessage],
      parameters: { max_tokens: 256, thinking: { type: "disabled" } },
    }, false);
    expect(suppressedBody.messages[1].content).toEqual([
      { type: "thinking", thinking: "seed", signature: "sig" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
    ]);
  });

  test("consumes a suppressed carrier once across multipart text parts", () => {
    const provider = new ExposedAnthropicProvider();
    expect(provider.exposeFormatContent({
      role: "assistant",
      content: [
        { type: "text", text: "seed" },
        { type: "text", text: "answer" },
        { type: "text", text: "seed-again" },
        { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
      ],
      thinking_blocks: [{ type: "thinking", thinking: "seed", signature: "sig", display_suppressed: true }],
    }, true)).toEqual([
      { type: "thinking", thinking: "seed", signature: "sig" },
      { type: "text", text: "" },
      { type: "text", text: "answer" },
      { type: "text", text: "seed-again" },
      { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
    ]);
    expect(provider.exposeFormatContent({
      role: "assistant",
      content: [
        { type: "text", text: "se" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "tool-2", name: "lookup", input: {} },
      ],
      thinking_blocks: [{ type: "thinking", thinking: "seed", signature: "sig", display_suppressed: true }],
    }, true)).toEqual([
      { type: "thinking", thinking: "seed", signature: "sig" },
      { type: "text", text: "se" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "tool-2", name: "lookup", input: {} },
    ]);
  });
  test("rejects malformed or mixed suppression provenance", () => {
    const provider = new ExposedAnthropicProvider();
    expect(() => provider.exposeFormatContent({
      role: "assistant",
      content: "answer",
      thinking_blocks: [
        {
          type: "thinking",
          thinking: "seed",
          display_suppressed: false as never,
        },
      ],
    }, false)).toThrow("Anthropic thinking provenance is malformed");
    expect(() => provider.exposeFormatContent({
      role: "assistant",
      content: "answer",
      thinking_blocks: [
        { type: "thinking", thinking: "seed", display_suppressed: true },
        { type: "redacted_thinking", data: "opaque" },
      ],
    }, false)).toThrow("Anthropic thinking provenance is incomplete");
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
  test("rejects a successful response with missing usage", async () => {
    const provider = new AnthropicProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
      }), { status: 200 })) as unknown as typeof fetch;
    try {
      await expect(provider.generate("key", "", {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        parameters: { max_tokens: 256 },
      })).rejects.toThrow("Anthropic usage is missing or malformed");
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

describe("AnthropicProvider model-controlled tool argument parsing", () => {
  test("non-streaming missing arguments reject before execution", async () => {
    const provider = new AnthropicProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [
            { type: "tool_use", id: "anthropic_missing", name: "lore_list_books" },
            {
              type: "tool_use",
              id: "anthropic_good",
              name: "lore_search_entries",
              input: { query: "x" },
            },
          ],
          stop_reason: "tool_use",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      await expect(provider.generate("key", "https://api.anthropic.com", {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "search" }],
        parameters: { max_tokens: 256 },
      })).rejects.toThrow("Anthropic tool_use input is malformed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("AnthropicProvider validation-error logging", () => {
  test("logs only closed metadata and never system, task, tool, or serialized payload content", () => {
    const provider = new AnthropicProvider();
    const uniqueSystem = "UNIQUE_SYSTEM_CONTENT_4f6de2";
    const uniqueTask = "UNIQUE_TASK_CONTENT_7a91b3";
    const uniqueTool = "UNIQUE_TOOL_CONTENT_2c84ef";
    const body = {
      model: "claude-sonnet-4-6",
      system: [
        { type: "text", text: uniqueSystem },
        { type: "text", text: "second system block" },
      ],
      messages: [{ role: "user", content: uniqueTask }],
      tools: [{ name: uniqueTool, description: "private", parameters: {} }],
    };
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      (provider as any).logSystemValidationError(
        body,
        "invalid_request_error: system.0: invalid content",
      );

      expect(errors).toHaveLength(1);
      expect(errors[0][0]).toBe("[anthropic] system validation failed");
      expect(errors[0][1]).toEqual({
        code: "invalid_request_error",
        model: "claude-sonnet-4-6",
        systemType: "array",
        systemUtf8Bytes: null,
        systemBlockCount: 2,
        messageCount: 1,
        toolCount: 1,
      });
      const serializedLog = JSON.stringify(errors);
      expect(serializedLog).not.toContain(uniqueSystem);
      expect(serializedLog).not.toContain(uniqueTask);
      expect(serializedLog).not.toContain(uniqueTool);
      expect(serializedLog).not.toContain(JSON.stringify(body));
    } finally {
      console.error = originalError;
    }
  });
});

type AnthropicSseEvent = {
  readonly data: Record<string, unknown>;
  readonly event?: string;
};

function anthropicSseResponse(
  events: readonly AnthropicSseEvent[],
  status = 200,
): Response {
  const body = events
    .map(({ data, event }) =>
      `${event === undefined ? "" : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function anthropicStreamRequest(signal?: AbortSignal) {
  return {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user" as const, content: "hi" }],
    parameters: { max_tokens: 256 },
    ...(signal ? { signal } : {}),
  };
}

async function collectAnthropicStream(
  response: Response,
  request = anthropicStreamRequest(),
): Promise<StreamChunk[]> {
  const provider = new AnthropicProvider();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  try {
    const chunks = [];
    for await (const chunk of provider.generateStream("key", "", request)) {
      chunks.push(chunk);
    }
    return chunks;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function terminalEvents(): AnthropicSseEvent[] {
  return [
    { data: { type: "message_start", message: { usage: { input_tokens: 0 } } } },
    { data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } } },
    { data: { type: "message_stop" } },
  ];
}

describe("AnthropicProvider bounded stream protocol", () => {
  test("preserves thinking, signature, and redacted carriers in order", async () => {
    const events: AnthropicSseEvent[] = [
      { data: { type: "message_start", message: { usage: { input_tokens: 1 } } } },
      {
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "seed", signature: "sig" },
        },
      },
      { data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "body" } } },
      { data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "-tail" } } },
      { data: { type: "content_block_stop", index: 0 } },
      {
        data: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "redacted_thinking", data: "opaque" },
        },
      },
      { data: { type: "content_block_stop", index: 1 } },
      ...terminalEvents().slice(1),
    ];

    const chunks = await collectAnthropicStream(anthropicSseResponse(events));
    expect(chunks.at(-1)?.thinking_blocks).toEqual([
      { type: "thinking", thinking: "seedbody", signature: "sig-tail" },
      { type: "redacted_thinking", data: "opaque" },
    ]);
  });
  test("emits nonempty text and thinking content from block starts", async () => {
    const events: AnthropicSseEvent[] = [
      { data: { type: "message_start", message: { usage: { input_tokens: 0 } } } },
      { data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "initial" } } },
      { data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "-tail" } } },
      { data: { type: "content_block_stop", index: 0 } },
      { data: { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "seed", signature: "sig" } } },
      { data: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "-body" } } },
      { data: { type: "content_block_stop", index: 1 } },
      ...terminalEvents().slice(1),
    ];

    const chunks = await collectAnthropicStream(anthropicSseResponse(events));
    expect(chunks.filter((chunk) => chunk.token).map((chunk) => chunk.token)).toEqual(["initial", "-tail"]);
    expect(chunks.filter((chunk) => chunk.reasoning).map((chunk) => chunk.reasoning)).toEqual(["seed", "-body"]);
  });

  test("emits initial thinking as visible text when display is suppressed", async () => {
    const events: AnthropicSseEvent[] = [
      { data: { type: "message_start", message: { usage: { input_tokens: 0 } } } },
      { data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "seed" } } },
      { data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "-body" } } },
      { data: { type: "content_block_stop", index: 0 } },
      ...terminalEvents().slice(1),
    ];
    const request = {
      ...anthropicStreamRequest(),
      parameters: { max_tokens: 256, thinking: { type: "disabled" as const } },
    };
    const chunks = await collectAnthropicStream(anthropicSseResponse(events), request);
    expect(chunks.filter((chunk) => chunk.token).map((chunk) => chunk.token)).toEqual(["seed", "-body"]);
    expect(chunks.some((chunk) => chunk.reasoning !== undefined)).toBe(false);
  });
  test("preserves native carriers while thinking display is suppressed", async () => {
    const events: AnthropicSseEvent[] = [
      { data: { type: "message_start", message: { usage: { input_tokens: 0 } } } },
      {
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "seed", signature: "" },
        },
      },
      { data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "body" } } },
      { data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "tail" } } },
      { data: { type: "content_block_stop", index: 0 } },
      {
        data: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "redacted_thinking", data: "opaque" },
        },
      },
      { data: { type: "content_block_stop", index: 1 } },
      ...terminalEvents().slice(1),
    ];
    const request = {
      ...anthropicStreamRequest(),
      parameters: { max_tokens: 256, thinking: { type: "disabled" } },
    };

    const chunks = await collectAnthropicStream(
      anthropicSseResponse(events),
      request,
    );
    expect(chunks.some((chunk) => chunk.token === "body")).toBe(true);
    expect(chunks.at(-1)?.thinking_blocks).toEqual([
      { type: "thinking", thinking: "seedbody", signature: "tail", display_suppressed: true },
      { type: "redacted_thinking", data: "opaque", display_suppressed: true },
    ]);
  });
  test("preserves native carriers in a suppressed non-stream response", async () => {
    const provider = new AnthropicProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        content: [
          { type: "thinking", thinking: "seed", signature: "" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "answer" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 1 },
      }), { status: 200 })) as unknown as typeof fetch;
    try {
      const response = await provider.generate("key", "", {
        ...anthropicStreamRequest(),
        parameters: { max_tokens: 256, thinking: { type: "disabled" } },
      });
      expect(response.content).toBe("seedanswer");
      expect(response.thinking_blocks).toEqual([
        { type: "thinking", thinking: "seed", signature: "", display_suppressed: true },
        { type: "redacted_thinking", data: "opaque", display_suppressed: true },
      ]);
      const continuation = new ExposedAnthropicProvider().exposeFormatContent({
        role: "assistant",
        content: response.content,
        thinking_blocks: response.thinking_blocks,
      }, true);
      expect(continuation).toEqual([
        { type: "thinking", thinking: "seed", signature: "" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "answer" },
      ]);
      const multipartContinuation = new ExposedAnthropicProvider().exposeFormatContent({
        role: "assistant",
        content: [
          { type: "text", text: "seedanswer" },
          { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
        ],
        thinking_blocks: response.thinking_blocks,
      }, true);
      expect(multipartContinuation).toEqual([
        { type: "thinking", thinking: "seed", signature: "" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("accepts the exact cumulative thinking and signature carrier cap", async () => {
    const piece = "x".repeat(32 * 1024);
    const events: AnthropicSseEvent[] = [
      { data: { type: "message_start", message: { usage: { input_tokens: 0 } } } },
      {
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking" },
        },
      },
    ];
    for (let index = 0; index < 4; index += 1) {
      events.push({
        data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: piece } },
      });
    }
    for (let index = 0; index < 4; index += 1) {
      events.push({
        data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: piece } },
      });
    }
    events.push(
      { data: { type: "content_block_stop", index: 0 } },
      ...terminalEvents().slice(1),
    );

    await expect(collectAnthropicStream(anthropicSseResponse(events))).resolves.toHaveLength(5);
  });

  test("rejects one signature byte past the cumulative carrier cap before append", async () => {
    const piece = "x".repeat(32 * 1024);
    const events: AnthropicSseEvent[] = [
      { data: { type: "message_start", message: { usage: { input_tokens: 0 } } } },
      {
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking" },
        },
      },
    ];
    for (let index = 0; index < 4; index += 1) {
      events.push({
        data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: piece } },
      });
    }
    for (let index = 0; index < 4; index += 1) {
      events.push({
        data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: piece } },
      });
    }
    events.push({
      data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "x" } },
    });

    await expect(collectAnthropicStream(anthropicSseResponse(events))).rejects.toMatchObject({
      code: "provider_response_too_large",
      limit: AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES,
      observed: AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES + 1,
    } satisfies Partial<ProviderResponseTooLargeError>);
  });

  test("rejects one redacted carrier byte past the cumulative cap incrementally", async () => {
    const piece = "x".repeat(32 * 1024);
    const events: AnthropicSseEvent[] = [
      { data: { type: "message_start", message: { usage: { input_tokens: 0 } } } },
    ];
    for (let index = 0; index < 8; index += 1) {
      events.push(
        {
          data: {
            type: "content_block_start",
            index,
            content_block: { type: "redacted_thinking", data: piece },
          },
        },
        { data: { type: "content_block_stop", index } },
      );
    }
    events.push({
      data: {
        type: "content_block_start",
        index: 8,
        content_block: { type: "redacted_thinking", data: "x" },
      },
    });

    await expect(collectAnthropicStream(anthropicSseResponse(events))).rejects.toMatchObject({
      code: "provider_response_too_large",
      observed: AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES + 1,
    });
  });


  test("rejects SSE event-name mismatches", async () => {
    const events: AnthropicSseEvent[] = [
      {
        event: "message_delta",
        data: { type: "message_start", message: { usage: { input_tokens: 0 } } },
      },
    ];
    await expect(collectAnthropicStream(anthropicSseResponse(events))).rejects.toBeInstanceOf(
      ProviderProtocolError,
    );
  });

  test.each([
    { label: "message_start missing usage", event: { type: "message_start", message: {} } },
    { label: "message_start string", event: { type: "message_start", message: { usage: { input_tokens: "1" } } } },
    { label: "message_start negative", event: { type: "message_start", message: { usage: { input_tokens: -1 } } } },
    { label: "message_delta missing usage", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
    { label: "message_delta fractional", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1.5 } } },
    { label: "message_delta unsafe", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: Number.MAX_SAFE_INTEGER + 1 } } },
  ])("rejects malformed usage ($label)", async ({ event }) => {
    const events: AnthropicSseEvent[] = [
      ...(event.type === "message_start"
        ? []
        : [{ data: { type: "message_start", message: { usage: { input_tokens: 0 } } } }]),
      { data: event },
    ];
    await expect(collectAnthropicStream(anthropicSseResponse(events))).rejects.toBeInstanceOf(
      ProviderProtocolError,
    );
  });

  test.each([
    {
      label: "delta index mismatch",
      events: [
        { data: { type: "message_start", message: { usage: { input_tokens: 0 } } } },
        { data: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
        { data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "x" } } },
      ],
    },
    {
      label: "delta type mismatch",
      events: [
        { data: { type: "message_start", message: { usage: { input_tokens: 0 } } } },
        { data: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
        { data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x" } } },
      ],
    },
    {
      label: "stop index mismatch",
      events: [
        { data: { type: "message_start", message: { usage: { input_tokens: 0 } } } },
        { data: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
        { data: { type: "content_block_stop", index: 1 } },
      ],
    },
    {
      label: "duplicate stop",
      events: [
        { data: { type: "message_start", message: { usage: { input_tokens: 0 } } } },
        { data: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
        { data: { type: "content_block_stop", index: 0 } },
        { data: { type: "content_block_stop", index: 0 } },
      ],
    },
    {
      label: "message delta before stop",
      events: [
        { data: { type: "message_start", message: { usage: { input_tokens: 0 } } } },
        { data: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
        { data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } } },
      ],
    },
  ])("rejects malformed content-block lifecycle ($label)", async ({ events }) => {
    await expect(collectAnthropicStream(anthropicSseResponse(events))).rejects.toBeInstanceOf(
      ProviderProtocolError,
    );
  });

  test("aborts an SSE read", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          encoder.encode(
            [
              "data: " + JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 0 } } }),
              "",
              "data: " + JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
              "",
              "data: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "first" } }),
              "",
            ].join("\n") + "\n"),
        );
      },
      pull(streamController) {
        streamController.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const provider = new AnthropicProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => response) as unknown as typeof fetch;
    try {
      const iterator = provider.generateStream("key", "", anthropicStreamRequest(controller.signal));
      const first = await iterator.next();
      expect(first).toMatchObject({ value: { token: "first" } });
      controller.abort(new Error("test abort"));
      await expect(iterator.next()).rejects.toThrow("test abort");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("error body reads honor receiveLimitBytes", async () => {
    const provider = new AnthropicProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("x".repeat(32), { status: 500 })) as unknown as typeof fetch;
    try {
      await expect(provider.generate("key", "", {
        ...anthropicStreamRequest(),
        receiveLimitBytes: 8,
      })).rejects.toMatchObject({
        provider: "Anthropic",
        operation: "generate",
        rawBody: "xxxxxxxx…[truncated]",
      } satisfies Partial<ProviderRequestError>);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("error body reads honor the caller abort signal", async () => {
    const provider = new AnthropicProvider();
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      controller.abort(new Error("error body abort"));
      return new Response("provider failure", { status: 500 });
    }) as unknown as typeof fetch;
    try {
      await expect(provider.generate("key", "", {
        ...anthropicStreamRequest(controller.signal),
      })).rejects.toThrow("error body abort");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
