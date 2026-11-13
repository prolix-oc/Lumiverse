import { describe, expect, test } from "bun:test";
import { getConnectionRouletteConfig, resolveEffectiveApiUrl } from "./connections.service";

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

  test("resolves Google Vertex and Vertex TTS endpoints from vertex_region", () => {
    expect(resolveEffectiveApiUrl({
      provider: "google_vertex",
      api_url: "",
      metadata: { vertex_region: "us-central1" },
    })).toBe("https://us-central1-aiplatform.googleapis.com");

    expect(resolveEffectiveApiUrl({
      provider: "google_vertex_tts",
      api_url: "",
      metadata: { vertex_region: "us-central1" },
    })).toBe("https://us-central1-aiplatform.googleapis.com");

    expect(resolveEffectiveApiUrl({
      provider: "google_vertex_tts",
      api_url: "",
      metadata: { vertex_region: "global" },
    })).toBe("https://aiplatform.googleapis.com");

    expect(resolveEffectiveApiUrl({
      provider: "google_vertex_tts",
      api_url: "",
      metadata: {},
    })).toBe("https://aiplatform.googleapis.com");
  });
});

describe("getConnectionRouletteConfig", () => {
  test("normalizes roulette target ids", () => {
    expect(getConnectionRouletteConfig({
      metadata: {
        connection_roulette: {
          connection_ids: [" a ", "", "b", "a", 42, "c"],
        },
      },
    })).toEqual({ connection_ids: ["a", "b", "c"] });
  });

  test("falls back to an empty roulette config", () => {
    expect(getConnectionRouletteConfig({ metadata: {} })).toEqual({ connection_ids: [] });
  });
});
