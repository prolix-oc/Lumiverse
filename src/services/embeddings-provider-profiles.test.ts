import { describe, expect, test } from "bun:test";
import { __test__, getProviderDefaults } from "./embeddings.service";

describe("embedding provider profiles", () => {
  test("restores the selected provider's saved settings on a provider-only update", () => {
    const openai = __test__.normalizeConfig({
      provider: "openai",
      model: "text-embedding-3-large",
      dimensions: 3072,
      send_dimensions: true,
    });
    const nim = __test__.normalizeConfig({
      provider: "nvidia-nim",
      model: "nvidia/llama-nemotron-embed-1b-v2",
      dimensions: 2048,
      send_dimensions: true,
      batch_size: 12,
    });
    const current = {
      ...openai,
      provider_profiles: {
        openai: openai.provider_profiles!.openai!,
        "nvidia-nim": nim.provider_profiles!["nvidia-nim"]!,
      },
    };

    const selected = __test__.mergeEmbeddingConfigUpdate(current, { provider: "nvidia-nim" });

    expect(selected.provider).toBe("nvidia-nim");
    expect(selected.api_url).toBe("https://integrate.api.nvidia.com/v1/embeddings");
    expect(selected.model).toBe("nvidia/llama-nemotron-embed-1b-v2");
    expect(selected.dimensions).toBe(2048);
    expect(selected.send_dimensions).toBe(true);
    expect(selected.batch_size).toBe(12);
  });

  test("adds NVIDIA NIM with Nemotron 3 as its safe default", () => {
    expect(getProviderDefaults("nvidia-nim")).toEqual({
      api_url: "https://integrate.api.nvidia.com/v1/embeddings",
      model: "nvidia/nemotron-3-embed-1b",
    });
    expect(__test__.NVIDIA_NIM_EMBEDDING_MODELS).toEqual(expect.arrayContaining([
      "nvidia/nv-embed-v1",
      "nvidia/nv-embedqa-e5-v5",
    ]));
  });

  test("uses query/passage routing only for NVIDIA's asymmetric models", () => {
    expect(__test__.nvidiaNimNeedsInputType({
      provider: "nvidia-nim",
      model: "nvidia/llama-nemotron-embed-1b-v2",
    })).toBe(true);
    expect(__test__.nvidiaNimNeedsInputType({
      provider: "nvidia-nim",
      model: "nvidia/nemotron-3-embed-1b",
    })).toBe(false);
  });

  test("surfaces NVIDIA's successful-HTTP problem detail", () => {
    expect(() => __test__.parseEmbeddingResponse({ detail: "Model unavailable" }, 1))
      .toThrow("Embedding provider returned an error: Model unavailable");
  });
});
