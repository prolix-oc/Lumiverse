import { describe, expect, test } from "bun:test";
import { resolveEffectiveApiUrl } from "./connections.service";

describe("resolveEffectiveApiUrl", () => {
  test("uses the current Z.AI general endpoint by default", () => {
    expect(resolveEffectiveApiUrl({ provider: "zai", api_url: "", metadata: {} })).toBe("https://api.z.ai/api/paas/v4");
  });

  test("switches Z.AI to the coding plan endpoint when enabled", () => {
    expect(resolveEffectiveApiUrl({
      provider: "zai",
      api_url: "https://api.z.ai/api/paas/v4",
      metadata: { use_coding_plan_endpoint: true },
    })).toBe("https://api.z.ai/api/coding/paas/v4");
  });

  test("normalizes legacy Z.AI v1 urls", () => {
    expect(resolveEffectiveApiUrl({
      provider: "zai",
      api_url: "https://api.z.ai/v1",
      metadata: {},
    })).toBe("https://api.z.ai/api/paas/v4");

    expect(resolveEffectiveApiUrl({
      provider: "zai",
      api_url: "https://api.z.ai/v1",
      metadata: { use_coding_plan_endpoint: true },
    })).toBe("https://api.z.ai/api/coding/paas/v4");
  });
});
