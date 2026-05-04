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
});
