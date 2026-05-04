import { describe, expect, test } from "bun:test";

import { AnthropicProvider } from "./anthropic";

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

    globalThis.fetch = async () =>
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
      ) as any;

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
