import { describe, expect, test } from "bun:test";

import { __test__ } from "./generate.service";

describe("injectConnectionMetadataFlags", () => {
  test("injects anthropic prompt caching config from connection metadata", () => {
    const params: Record<string, unknown> = {};

    __test__.injectConnectionMetadataFlags(
      {
        provider: "anthropic",
        metadata: {
          prompt_caching: { type: "ephemeral", ttl: "1h" },
        },
      },
      params,
    );

    expect(params.prompt_caching).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("does not inject disabled anthropic prompt caching", () => {
    const params: Record<string, unknown> = {};

    __test__.injectConnectionMetadataFlags(
      {
        provider: "anthropic",
        metadata: {
          prompt_caching: false,
        },
      },
      params,
    );

    expect(params.prompt_caching).toBeUndefined();
  });

  test("injects nanogpt caching params when enabled", () => {
    const params: Record<string, unknown> = {};

    __test__.injectConnectionMetadataFlags(
      {
        provider: "nanogpt",
        metadata: {
          nanogpt_caching: { enabled: true, ttl: "1h", stickyProvider: true },
        },
      },
      params,
    );

    expect(params.caching).toBe(true);
    expect(params.stickyProvider).toBe(true);
    expect(params.prompt_caching).toEqual({ enabled: true, ttl: "1h", stickyProvider: true });
  });

  test("defaults nanogpt caching ttl to 5m and stickyProvider to true", () => {
    const params: Record<string, unknown> = {};

    __test__.injectConnectionMetadataFlags(
      {
        provider: "nanogpt",
        metadata: {
          nanogpt_caching: { enabled: true },
        },
      },
      params,
    );

    expect(params.prompt_caching).toEqual({ enabled: true, ttl: "5m", stickyProvider: true });
    expect(params.stickyProvider).toBe(true);
  });

  test("honors stickyProvider=false on nanogpt caching", () => {
    const params: Record<string, unknown> = {};

    __test__.injectConnectionMetadataFlags(
      {
        provider: "nanogpt",
        metadata: {
          nanogpt_caching: { enabled: true, ttl: "5m", stickyProvider: false },
        },
      },
      params,
    );

    expect(params.stickyProvider).toBe(false);
    expect(params.prompt_caching).toEqual({ enabled: true, ttl: "5m", stickyProvider: false });
  });

  test("does not inject disabled nanogpt caching", () => {
    const params: Record<string, unknown> = {};

    __test__.injectConnectionMetadataFlags(
      {
        provider: "nanogpt",
        metadata: {
          nanogpt_caching: false,
        },
      },
      params,
    );

    expect(params.caching).toBeUndefined();
    expect(params.stickyProvider).toBeUndefined();
    expect(params.prompt_caching).toBeUndefined();
  });
});

describe("anthropic prompt caching helpers", () => {
  test("parses explicit breakpoint settings from connection metadata", () => {
    const config = __test__.resolveAnthropicPromptCachingConfig({
      prompt_caching: {
        type: "ephemeral",
        ttl: "1h",
        automatic: false,
        breakpoints: {
          tools: true,
          system: true,
          messages: true,
        },
      },
    });

    expect(config).toEqual({
      enabled: true,
      automatic: false,
      cacheControl: { type: "ephemeral", ttl: "1h" },
      breakpoints: {
        tools: true,
        system: true,
        messages: true,
      },
    });
  });

  test("applies message and tool breakpoints to anthropic requests", () => {
    const config = __test__.resolveAnthropicPromptCachingConfig({
      prompt_caching: {
        type: "ephemeral",
        breakpoints: {
          tools: true,
          system: true,
          messages: true,
        },
      },
    });

    const messages = __test__.applyAnthropicCacheBreakpointsToMessages(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "reply" },
      ],
      config,
    );
    const tools = __test__.applyAnthropicCacheBreakpointsToTools(
      [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
      config,
    );

    expect(messages).toEqual([
      { role: "system", content: "sys", cache_control: { type: "ephemeral" } },
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply", cache_control: { type: "ephemeral" } },
    ]);
    expect(tools).toEqual([
      {
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });
});
