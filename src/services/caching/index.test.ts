import { describe, expect, test } from "bun:test";

import { applyPromptCaching } from "./index";

describe("applyPromptCaching dispatcher", () => {
  test("dispatches to anthropic strategy", () => {
    const result = applyPromptCaching(
      {
        provider: "anthropic",
        metadata: { prompt_caching: { type: "ephemeral", ttl: "1h" } },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.prompt_caching).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("dispatches to nanogpt strategy", () => {
    const result = applyPromptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: { nanogpt_caching: { enabled: true } },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.prompt_caching).toEqual({
      enabled: true,
      ttl: "5m",
      stickyProvider: true,
    });
  });

  test("passes through unchanged for providers without a strategy", () => {
    const input = { params: { temperature: 0.7 }, messages: [] };
    const result = applyPromptCaching(
      { provider: "openai", metadata: { prompt_caching: true } },
      input,
    );
    expect(result).toBe(input);
  });

  test("passes through unchanged when provider has no metadata", () => {
    const input = { params: {}, messages: [] };
    const result = applyPromptCaching({ provider: "anthropic" }, input);
    // Anthropic strategy runs but returns no-op transformation.
    expect(result.params.prompt_caching).toBeUndefined();
    expect(result.messages).toEqual([]);
  });
});
