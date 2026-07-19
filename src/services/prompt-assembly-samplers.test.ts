import { describe, expect, test } from "bun:test";

import { buildParameters } from "./prompt-assembly.service";
import type { Preset, SamplerOverrides } from "../types/preset";

function samplerOverrides(
  overrides: Partial<SamplerOverrides> = {},
): SamplerOverrides {
  return {
    enabled: true,
    maxTokens: null,
    contextSize: null,
    temperature: null,
    topP: null,
    minP: null,
    topK: null,
    frequencyPenalty: null,
    presencePenalty: null,
    repetitionPenalty: null,
    streaming: true,
    ...overrides,
  };
}

describe("sampler parameter assembly", () => {
  test("omits top_p when Top P is set to zero", () => {
    const parameters = buildParameters(
      samplerOverrides({ topP: 0 }),
      null,
    );

    expect(parameters).not.toHaveProperty("top_p");
  });

  test("includes top_p when Top P is non-zero", () => {
    const parameters = buildParameters(
      samplerOverrides({ topP: 0.8 }),
      null,
    );

    expect(parameters.top_p).toBe(0.8);
  });

  test("applies the reasoning custom body instead of the legacy preset body", () => {
    const preset = {
      parameters: {
        customBody: { enabled: true, rawJson: '{"legacy":true,"priority":"preset"}' },
      },
      prompts: {},
    } as unknown as Preset;

    const parameters = buildParameters(
      null,
      preset,
      {
        customBody: { enabled: true, rawJson: '{"bound":true,"priority":"reasoning"}' },
      },
    );

    expect(parameters).toEqual({ bound: true, priority: "reasoning" });
  });

  test("keeps a legacy preset custom body until a reasoning body is saved", () => {
    const preset = {
      parameters: {
        customBody: { enabled: true, rawJson: '{"legacy":true}' },
      },
      prompts: {},
    } as unknown as Preset;

    expect(buildParameters(null, preset, {})).toEqual({ legacy: true });
    expect(
      buildParameters(null, preset, {
        customBody: { enabled: false, rawJson: '{}' },
      }),
    ).toEqual({});
  });

  test("applies the reasoning off switch after a custom body", () => {
    const parameters = buildParameters(
      null,
      null,
      {
        apiReasoning: false,
        customBody: { enabled: true, rawJson: '{"reasoning":{"effort":"high"}}' },
      },
      "openrouter",
    );

    expect(parameters).not.toHaveProperty("reasoning");
  });
});
