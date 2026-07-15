import { describe, expect, test } from "bun:test";

import { buildParameters } from "./prompt-assembly.service";
import type { SamplerOverrides } from "../types/preset";

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
});
