import { describe, expect, test } from "bun:test";

import { applyProviderReasoningOffSwitch } from "./prompt-assembly.service";

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
});
