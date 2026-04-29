import { describe, expect, test } from "bun:test";

import { applyProviderReasoningOffSwitch } from "./prompt-assembly.service";

describe("applyProviderReasoningOffSwitch", () => {
  test("removes generic reasoning fields for OpenAI-compatible providers", () => {
    const params = {
      reasoning: { effort: "high" },
      reasoning_effort: "max",
      thinking: { type: "enabled" },
      temperature: 0.8,
    };

    applyProviderReasoningOffSwitch(params, "openai");

    expect(params).toEqual({ temperature: 0.8 });
  });

  test("preserves non-reasoning Anthropic output config while disabling thinking", () => {
    const params = {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max", other_flag: true },
      temperature: 0.7,
    };

    applyProviderReasoningOffSwitch(params, "anthropic", "claude-sonnet-4.7");

    expect(params).toEqual({
      thinking: { type: "disabled" },
      output_config: { other_flag: true },
      temperature: 0.7,
    });
  });

  test("forces DeepSeek thinking off and strips effort fields", () => {
    const params = {
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      reasoning: { effort: "high" },
      top_p: 0.9,
    };

    applyProviderReasoningOffSwitch(params, "deepseek");

    expect(params).toEqual({
      thinking: { type: "disabled" },
      top_p: 0.9,
    });
  });

  test("switches NanoGPT to exclude mode without sending effort", () => {
    const params = {
      reasoning: { effort: "high", delta_field: true },
      reasoning_effort: "high",
      max_tokens: 256,
    };

    applyProviderReasoningOffSwitch(params, "nanogpt");

    expect(params).toEqual({
      reasoning: { exclude: true },
      max_tokens: 256,
    });
  });
});
