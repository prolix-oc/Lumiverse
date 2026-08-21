import { describe, expect, test } from "bun:test";

import { applyProviderReasoningOffSwitch, buildParameters, injectReasoningParams } from "./prompt-assembly.service";

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

describe("injectReasoningParams (Anthropic)", () => {
  for (const model of [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-future-family-5.1",
  ]) {
    test(`uses adaptive thinking for ${model}`, () => {
      const params: Record<string, any> = {};

      injectReasoningParams(params, "anthropic", "max", model);

      expect(params.thinking).toEqual({ type: "adaptive" });
      expect(params.output_config).toEqual({ effort: "max" });
    });
  }
});

describe("injectReasoningParams (OpenAI-compatible)", () => {
  test("passes xhigh through for OpenAI and custom connections", () => {
    for (const provider of ["openai", "custom"]) {
      const params: Record<string, any> = {};
      injectReasoningParams(params, provider, "xhigh");
      expect(params.reasoning).toEqual({ effort: "xhigh" });
    }
  });

  test("passes xhigh through for NanoGPT", () => {
    const params: Record<string, any> = {};
    injectReasoningParams(params, "nanogpt", "xhigh");
    expect(params.reasoning).toEqual({ effort: "xhigh" });
    expect(params.reasoning_effort).toBeUndefined();
  });
});

describe("buildParameters (Google thought signatures)", () => {
  test("keeps optional signature replay scoped to enabled Google API reasoning", () => {
    const params = buildParameters(
      null,
      null,
      { apiReasoning: true, replayThoughtSignatures: true },
      "google",
      "gemini-3-flash",
    );
    expect(params._replay_thought_signatures).toBe(true);

    const disabled = buildParameters(
      null,
      null,
      { apiReasoning: false, replayThoughtSignatures: true },
      "google_vertex",
      "gemini-3-flash",
    );
    expect(disabled._replay_thought_signatures).toBeUndefined();
  });
});

describe("injectReasoningParams (zai)", () => {
  test("sends thinking and reasoning_effort for GLM-5.2 models", () => {
    const params: Record<string, any> = {};
    injectReasoningParams(params, "zai", "auto", "glm-5.2");
    expect(params.thinking).toEqual({ type: "enabled" });
    expect(params.reasoning_effort).toBe("max");
  });

  test("passes through valid reasoning_effort values for GLM-5.x", () => {
    const high: Record<string, any> = {};
    injectReasoningParams(high, "zai", "high", "glm-5");
    expect(high.reasoning_effort).toBe("high");

    const xhigh: Record<string, any> = {};
    injectReasoningParams(xhigh, "zai", "xhigh", "glm-5.1");
    expect(xhigh.reasoning_effort).toBe("xhigh");
  });

  test("limits GLM-5.3 to its documented low, high, and max effort levels", () => {
    for (const effort of ["low", "high", "max"] as const) {
      const params: Record<string, any> = {};
      injectReasoningParams(params, "zai", effort, "glm-5.3");
      expect(params.reasoning_effort).toBe(effort);
    }

    const unsupported: Record<string, any> = {};
    injectReasoningParams(unsupported, "zai", "medium", "glm-5.3");
    expect(unsupported.reasoning_effort).toBe("max");
  });

  test("uses Z.AI's default clear-thinking behaviour for GLM-4.5+ unless configured", () => {
    const params: Record<string, any> = {};
    injectReasoningParams(params, "zai", "max", "glm-4.5");
    expect(params.thinking).toEqual({ type: "enabled" });
    expect(params.reasoning_effort).toBeUndefined();
  });

  test("forwards a user-selected clear-thinking value for GLM-4.5+ and GLM-5.x", () => {
    const glm45: Record<string, any> = {};
    injectReasoningParams(glm45, "zai", "auto", "glm-4.5", undefined, false);
    expect(glm45.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(glm45.reasoning_effort).toBeUndefined();

    const glm53: Record<string, any> = {};
    injectReasoningParams(glm53, "zai", "auto", "glm-5.3", undefined, true);
    expect(glm53.thinking).toEqual({ type: "enabled", clear_thinking: true });
    expect(glm53.reasoning_effort).toBe("max");
  });

  test("does not override explicit thinking or reasoning_effort", () => {
    const params: Record<string, any> = {
      thinking: { type: "disabled" },
      reasoning_effort: "none",
    };
    injectReasoningParams(params, "zai", "max", "glm-5.2");
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params.reasoning_effort).toBe("none");
  });
});

describe("injectReasoningParams (moonshot)", () => {
  test("K3 uses top-level reasoning_effort and omits thinking", () => {
    const params: Record<string, any> = {};
    injectReasoningParams(params, "moonshot", "auto", "kimi-k3");
    expect(params.reasoning_effort).toBe("max");
    expect(params.thinking).toBeUndefined();
  });

  test("K2.7-code uses preserved-thinking thinking config", () => {
    const params: Record<string, any> = {};
    injectReasoningParams(params, "moonshot", "auto", "kimi-k2.7-code");
    expect(params.thinking).toEqual({ type: "enabled", keep: "all" });
    expect(params.reasoning_effort).toBeUndefined();
  });

  test("K2.6 uses thinking enabled toggle", () => {
    const params: Record<string, any> = {};
    injectReasoningParams(params, "moonshot", "auto", "kimi-k2.6");
    expect(params.thinking).toEqual({ type: "enabled" });
    expect(params.reasoning_effort).toBeUndefined();
  });

  test("does not override explicit reasoning_effort on K3", () => {
    const params: Record<string, any> = { reasoning_effort: "low" };
    injectReasoningParams(params, "moonshot", "max", "kimi-k3");
    expect(params.reasoning_effort).toBe("low");
    expect(params.thinking).toBeUndefined();
  });
});

describe("applyProviderReasoningOffSwitch (zai & moonshot)", () => {
  test("disables Z.AI reasoning via thinking disabled", () => {
    const params: Record<string, any> = {
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    };
    applyProviderReasoningOffSwitch(params, "zai", "glm-5.2");
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params.reasoning_effort).toBeUndefined();
  });

  test("disables Moonshot K2.6 reasoning via thinking disabled", () => {
    const params: Record<string, any> = {
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    };
    applyProviderReasoningOffSwitch(params, "moonshot", "kimi-k2.6");
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params.reasoning_effort).toBeUndefined();
  });

  test("K3 off-switch strips reasoning params without sending disabled thinking", () => {
    const params: Record<string, any> = {
      reasoning_effort: "max",
      thinking: { type: "enabled" },
    };
    applyProviderReasoningOffSwitch(params, "moonshot", "kimi-k3");
    expect(params.thinking).toBeUndefined();
    expect(params.reasoning_effort).toBeUndefined();
  });

  test("K2.7-code off-switch strips reasoning params without sending disabled thinking", () => {
    const params: Record<string, any> = {
      thinking: { type: "enabled", keep: "all" },
    };
    applyProviderReasoningOffSwitch(params, "moonshot", "kimi-k2.7-code");
    expect(params.thinking).toBeUndefined();
    expect(params.reasoning_effort).toBeUndefined();
  });
});
