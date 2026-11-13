import { describe, expect, spyOn, test } from "bun:test";
import { applyEffectiveReasoningSettings } from "./reasoning";
import type { GenerationParameters } from "../../llm/types";
import * as settings from "../settings.service";

describe("raw generation reasoning inheritance", () => {
  test("inherit uses the selected connection's bound GLM settings, including preserved thinking", () => {
    const params: GenerationParameters = {};
    applyEffectiveReasoningSettings("alice", { metadata: { reasoningBindings: { settings: {
      apiReasoning: true, reasoningEffort: "high", clearThinking: false,
      customBody: { enabled: true, rawJson: '{"max_tokens":24000}' },
    } } } }, "zai", "glm-5.3-flash", params, { source: "inherit" }, true);
    expect(params.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(params.reasoning_effort).toBe("high");
    expect(params.max_tokens).toBe(24000);
  });

  test("inherit falls back to the account's settings when the connection has no reasoning binding", () => {
    const globalSettings = spyOn(settings, "getSetting").mockReturnValue({ key: "reasoningSettings", updated_at: 0,
      value: { apiReasoning: true, reasoningEffort: "high" } });
    try {
      const params: GenerationParameters = {};
      applyEffectiveReasoningSettings("alice", { metadata: {} }, "zai", "glm-5.3-flash", params, { source: "inherit" }, true);
      expect(globalSettings).toHaveBeenCalledWith("alice", "reasoningSettings");
      expect(params.thinking).toMatchObject({ type: "enabled" });
      expect(params.reasoning_effort).toBe("high");
    } finally { globalSettings.mockRestore(); }
  });

  test("inherit preserves a user's disabled setting instead of forcing thinking on", () => {
    const params: GenerationParameters = {};
    applyEffectiveReasoningSettings("alice", { metadata: { reasoningBindings: { settings: {
      apiReasoning: false,
    } } } }, "zai", "glm-4.7", params, { source: "inherit" }, true);
    expect(params.thinking).toEqual({ type: "disabled" });
  });
});
