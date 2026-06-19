import { describe, expect, test } from "bun:test";

import { applyAnthropicCaching, __test__ } from "./anthropic";

describe("applyAnthropicCaching", () => {
  test("copies truthy prompt_caching metadata into params for the provider body", () => {
    const result = applyAnthropicCaching(
      {
        provider: "anthropic",
        metadata: { prompt_caching: { type: "ephemeral", ttl: "1h" } },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.prompt_caching).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("does not inject prompt_caching when disabled", () => {
    const result = applyAnthropicCaching(
      {
        provider: "anthropic",
        metadata: { prompt_caching: false },
      },
      { params: {}, messages: [] },
    );
    expect(result.params.prompt_caching).toBeUndefined();
  });

  test("applies message and tool breakpoints when configured", () => {
    const result = applyAnthropicCaching(
      {
        provider: "anthropic",
        metadata: {
          prompt_caching: {
            type: "ephemeral",
            breakpoints: { tools: true, system: true, messages: true },
          },
        },
      },
      {
        params: {},
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "reply" },
        ],
        tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
      },
    );
    expect(result.messages).toEqual([
      { role: "system", content: "sys", cache_control: { type: "ephemeral" } },
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply", cache_control: { type: "ephemeral" } },
    ]);
    expect(result.tools).toEqual([
      {
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  test("leaves messages and tools untouched without breakpoint config (no system message)", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    const tools = [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }];
    const result = applyAnthropicCaching(
      { provider: "anthropic", metadata: { prompt_caching: true } },
      { params: {}, messages, tools },
    );
    expect(result.messages).toBe(messages);
    expect(result.tools).toBe(tools);
  });

  test("caches the system prefix by default when caching is enabled", () => {
    const result = applyAnthropicCaching(
      { provider: "anthropic", metadata: { prompt_caching: true } },
      {
        params: {},
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      },
    );
    // System block marked by default; the volatile user turn is not, and tools
    // are not touched without an explicit tools breakpoint.
    expect(result.messages).toEqual([
      { role: "system", content: "sys", cache_control: { type: "ephemeral" } },
      { role: "user", content: "hello" },
    ]);
  });

  test("marks only the last leading system message (single breakpoint for the prefix)", () => {
    const result = applyAnthropicCaching(
      { provider: "anthropic", metadata: { prompt_caching: true } },
      {
        params: {},
        messages: [
          { role: "system", content: "a" },
          { role: "system", content: "b" },
          { role: "user", content: "hi" },
        ],
      },
    );
    expect(result.messages).toEqual([
      { role: "system", content: "a" },
      { role: "system", content: "b", cache_control: { type: "ephemeral" } },
      { role: "user", content: "hi" },
    ]);
  });

  test("system breakpoint can be disabled explicitly", () => {
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "hi" },
    ];
    const result = applyAnthropicCaching(
      {
        provider: "anthropic",
        metadata: { prompt_caching: { type: "ephemeral", breakpoints: { system: false } } },
      },
      { params: {}, messages },
    );
    expect(result.messages).toBe(messages);
  });
});

describe("resolveConfig (private)", () => {
  test("parses explicit breakpoint settings from connection metadata", () => {
    const config = __test__.resolveConfig({
      prompt_caching: {
        type: "ephemeral",
        ttl: "1h",
        automatic: false,
        breakpoints: { tools: true, system: true, messages: true },
      },
    });
    expect(config).toEqual({
      enabled: true,
      automatic: false,
      cacheControl: { type: "ephemeral", ttl: "1h" },
      breakpoints: { tools: true, system: true, messages: true },
    });
  });

  test("returns disabled config for non-object metadata", () => {
    expect(__test__.resolveConfig(undefined).enabled).toBe(false);
    expect(__test__.resolveConfig({ prompt_caching: false }).enabled).toBe(false);
    expect(__test__.resolveConfig({ prompt_caching: [] }).enabled).toBe(false);
  });

  test("treats `prompt_caching: true` as enabled with default ephemeral control", () => {
    const config = __test__.resolveConfig({ prompt_caching: true });
    expect(config.enabled).toBe(true);
    expect(config.cacheControl).toEqual({ type: "ephemeral" });
  });

  test("defaults the system breakpoint on (messages/tools stay off)", () => {
    const config = __test__.resolveConfig({ prompt_caching: true });
    expect(config.breakpoints).toEqual({ tools: false, system: true, messages: false });
  });

  test("respects an explicit system: false opt-out", () => {
    const config = __test__.resolveConfig({
      prompt_caching: { type: "ephemeral", breakpoints: { system: false } },
    });
    expect(config.breakpoints.system).toBe(false);
  });
});
