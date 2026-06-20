import { describe, expect, test } from "bun:test";

import { applyProviderReasoningOffSwitch, injectReasoningParams } from "./prompt-assembly.service";

describe("applyProviderReasoningOffSwitch", () => {
  test("removes generic reasoning fields for OpenAI-compatible providers", () => {
    const params: Record<string, any> = {
      reasoning: { effort: "high" },
      reasoning_effort: "max",
      thinking: { type: "enabled" },
      temperature: 0.8,
    };

    applyProviderReasoningOffSwitch(params, "openai");

    expect(params.reasoning).toBeUndefined();
    expect(params.reasoning_effort).toBeUndefined();
    expect(params.thinking).toBeUndefined();
    expect(params.temperature).toBe(0.8);
  });

  test("always sends Anthropic's explicit disabled thinking config", () => {
    const params: Record<string, any> = {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max", other_flag: true },
      temperature: 0.7,
    };

    applyProviderReasoningOffSwitch(params, "anthropic", "claude-3-7-sonnet");

    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params.output_config).toEqual({ other_flag: true });
    expect(params.temperature).toBe(0.7);
  });

  test("forces DeepSeek thinking off and strips effort fields", () => {
    const params: Record<string, any> = {
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      reasoning: { effort: "high" },
      top_p: 0.9,
    };

    applyProviderReasoningOffSwitch(params, "deepseek");

    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params.reasoning).toBeUndefined();
    expect(params.reasoning_effort).toBeUndefined();
    expect(params.top_p).toBe(0.9);
  });

  test("switches NanoGPT to exclude mode without sending effort", () => {
    const params: Record<string, any> = {
      reasoning: { effort: "high", delta_field: true },
      reasoning_effort: "high",
      max_tokens: 256,
    };

    applyProviderReasoningOffSwitch(params, "nanogpt");

    expect(params.reasoning).toEqual({ exclude: true });
    expect(params.reasoning_effort).toBeUndefined();
    expect(params.max_tokens).toBe(256);
  });

  test("disables Bedrock reasoning via reasoning_effort none", () => {
    const params: Record<string, any> = {
      reasoning: { effort: "high" },
      reasoning_effort: "high",
      temperature: 0.6,
    };

    applyProviderReasoningOffSwitch(params, "bedrock");

    expect(params.reasoning).toBeUndefined();
    expect(params.reasoning_effort).toBe("none");
    expect(params.temperature).toBe(0.6);
  });
});

describe("injectReasoningParams (bedrock)", () => {
  test("sets top-level reasoning_effort and omits the generic reasoning object", () => {
    const params: Record<string, any> = {};
    injectReasoningParams(params, "bedrock", "medium", "us.anthropic.claude-sonnet-4-6");
    expect(params.reasoning_effort).toBe("medium");
    expect(params.reasoning).toBeUndefined();
  });

  test("clamps higher tiers (xhigh/max) down to high", () => {
    const xhigh: Record<string, any> = {};
    injectReasoningParams(xhigh, "bedrock", "xhigh", "openai.gpt-oss-120b");
    expect(xhigh.reasoning_effort).toBe("high");

    const max: Record<string, any> = {};
    injectReasoningParams(max, "bedrock", "max", "openai.gpt-oss-120b");
    expect(max.reasoning_effort).toBe("high");
  });

  test("does not override an explicit reasoning_effort", () => {
    const params: Record<string, any> = { reasoning_effort: "low" };
    injectReasoningParams(params, "bedrock", "high", "openai.gpt-oss-120b");
    expect(params.reasoning_effort).toBe("low");
  });
});
