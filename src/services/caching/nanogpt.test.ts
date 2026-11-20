import { describe, expect, test } from "bun:test";

import { applyNanoGptCaching, isNanoGptClaudeModel } from "./nanogpt";

describe("isNanoGptClaudeModel", () => {
  test("matches bare claude- ids", () => {
    expect(isNanoGptClaudeModel("claude-sonnet-4-5")).toBe(true);
    expect(isNanoGptClaudeModel("claude-haiku-4-5")).toBe(true);
    expect(isNanoGptClaudeModel("claude-opus-4-5")).toBe(true);
  });

  test("matches vendor-prefixed claude routes", () => {
    expect(isNanoGptClaudeModel("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isNanoGptClaudeModel("anthropic/claude-opus-4-5:thinking")).toBe(true);
  });

  test("rejects non-Claude models", () => {
    expect(isNanoGptClaudeModel("zai-org/glm-5")).toBe(false);
    expect(isNanoGptClaudeModel("openai/gpt-4o")).toBe(false);
    expect(isNanoGptClaudeModel("gemini-2.5-pro")).toBe(false);
    expect(isNanoGptClaudeModel("deepseek-v3")).toBe(false);
    expect(isNanoGptClaudeModel(undefined)).toBe(false);
    expect(isNanoGptClaudeModel(null)).toBe(false);
    expect(isNanoGptClaudeModel("")).toBe(false);
  });
});

describe("applyNanoGptCaching", () => {
  test("emits prompt_caching helper for Claude models when enabled", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: { nanogpt_caching: { enabled: true, ttl: "1h", stickyProvider: true } },
      },
      { params: {}, messages: [] },
    );
    // Top-level `caching` / `stickyProvider` must NOT be emitted — they bias
    // NanoGPT's provider routing to cache-capable upstreams and bypass
    // subscription coverage for non-Anthropic models.
    expect(result.params.caching).toBeUndefined();
    expect(result.params.stickyProvider).toBeUndefined();
    expect(result.params.prompt_caching).toEqual({ enabled: true, ttl: "1h", stickyProvider: true });
  });

  test("defaults ttl to 5m and stickyProvider to true", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-haiku-4-5",
        metadata: { nanogpt_caching: { enabled: true } },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.prompt_caching).toEqual({ enabled: true, ttl: "5m", stickyProvider: true });
  });

  test("honors stickyProvider=false", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: { nanogpt_caching: { enabled: true, ttl: "5m", stickyProvider: false } },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.prompt_caching).toEqual({ enabled: true, ttl: "5m", stickyProvider: false });
  });

  test("skips non-Claude models (relies on implicit caching)", () => {
    const input = { params: {}, messages: [] };
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "zai-org/glm-5",
        metadata: { nanogpt_caching: { enabled: true, ttl: "1h", stickyProvider: true } },
      },
      input,
    );
    // Pass-through — same bundle returned.
    expect(result).toBe(input);
    expect(result.params.prompt_caching).toBeUndefined();
  });

  test("does nothing when caching is disabled", () => {
    const input = { params: {}, messages: [] };
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: { nanogpt_caching: false },
      },
      input,
    );
    expect(result).toBe(input);
  });

  test("does nothing when model is unknown", () => {
    const input = { params: {}, messages: [] };
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        metadata: { nanogpt_caching: { enabled: true } },
      },
      input,
    );
    expect(result).toBe(input);
  });

  test("forwards cutAfterMessageIndex when set as a non-negative integer", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: {
          nanogpt_caching: { enabled: true, cutAfterMessageIndex: 4 },
        },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.prompt_caching).toEqual({
      enabled: true,
      ttl: "5m",
      stickyProvider: true,
      cutAfterMessageIndex: 4,
    });
  });

  test("accepts snake_case cut_after_message_index alias", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: {
          nanogpt_caching: { enabled: true, cut_after_message_index: 7 },
        },
      },
      { params: {}, messages: [] },
    );
    expect((result.params.prompt_caching as any).cutAfterMessageIndex).toBe(7);
  });

  test("rejects invalid cutAfterMessageIndex values", () => {
    for (const bad of [-1, 1.5, "3", null, NaN, true]) {
      const result = applyNanoGptCaching(
        {
          provider: "nanogpt",
          model: "claude-sonnet-4-5",
          metadata: {
            nanogpt_caching: { enabled: true, cutAfterMessageIndex: bad },
          },
        },
        { params: {}, messages: [] },
      );
      expect((result.params.prompt_caching as any).cutAfterMessageIndex).toBeUndefined();
    }
  });

  test("forwards explicitCacheControl only when explicitly true", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: {
          nanogpt_caching: { enabled: true, explicitCacheControl: true },
        },
      },
      { params: {}, messages: [] },
    );
    expect((result.params.prompt_caching as any).explicitCacheControl).toBe(true);
  });

  test("accepts snake_case explicit_cache_control alias", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: {
          nanogpt_caching: { enabled: true, explicit_cache_control: true },
        },
      },
      { params: {}, messages: [] },
    );
    expect((result.params.prompt_caching as any).explicitCacheControl).toBe(true);
  });

  test("omits explicitCacheControl when false or unset (NanoGPT default is false)", () => {
    for (const value of [false, undefined, "true", 1]) {
      const result = applyNanoGptCaching(
        {
          provider: "nanogpt",
          model: "claude-sonnet-4-5",
          metadata: {
            nanogpt_caching: { enabled: true, explicitCacheControl: value },
          },
        },
        { params: {}, messages: [] },
      );
      expect((result.params.prompt_caching as any).explicitCacheControl).toBeUndefined();
    }
  });

  test("emits top-level caching:true when forceCacheCapableRouting is set on a non-Claude model", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "zai-org/glm-5",
        metadata: {
          nanogpt_caching: { enabled: true, forceCacheCapableRouting: true },
        },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.caching).toBe(true);
    // Non-Claude → no prompt_caching helper.
    expect(result.params.prompt_caching).toBeUndefined();
  });

  test("emits caching:true AND prompt_caching helper for Claude with force-routing", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "claude-sonnet-4-5",
        metadata: {
          nanogpt_caching: {
            enabled: true,
            ttl: "1h",
            stickyProvider: true,
            forceCacheCapableRouting: true,
          },
        },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.caching).toBe(true);
    expect(result.params.prompt_caching).toEqual({
      enabled: true,
      ttl: "1h",
      stickyProvider: true,
    });
  });

  test("accepts snake_case force_cache_capable_routing alias", () => {
    const result = applyNanoGptCaching(
      {
        provider: "nanogpt",
        model: "zai-org/glm-5",
        metadata: {
          nanogpt_caching: { enabled: true, force_cache_capable_routing: true },
        },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.caching).toBe(true);
  });

  test("does not emit caching:true when forceCacheCapableRouting is anything but strict true", () => {
    for (const value of [false, undefined, "true", 1, null]) {
      const result = applyNanoGptCaching(
        {
          provider: "nanogpt",
          model: "zai-org/glm-5",
          metadata: {
            nanogpt_caching: { enabled: true, forceCacheCapableRouting: value },
          },
        },
        { params: {}, messages: [] },
      );
      expect(result.params.caching).toBeUndefined();
    }
  });
});
