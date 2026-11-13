import { describe, expect, mock, test } from "bun:test";

const connections = new Map<string, {
  id: string;
  name: string;
  provider: string;
  model: string;
  has_api_key: boolean;
}>();

mock.module("../services/connections.service", () => ({
  resolveConnection: (_userId: string, id?: string) => connections.get(id ?? "") ?? null,
  testConnection: async () => ({
    success: false,
    timedOut: true,
    message: "timeout",
    durationMs: 5,
    error: "timeout",
  }),
}));

mock.module("../llm/registry", () => ({
  getProvider: (provider?: string) => provider
    ? { capabilities: { apiKeyRequired: true } }
    : null,
}));

const { describeCortexSidecarHealth, resolveCortexSidecarAdapter } = await import("./memory-cortex.routes");
const { normalizeCortexConfig } = await import("../services/memory-cortex/config");

function configWith(primaryId: string | null, secondaryId: string | null = null) {
  return normalizeCortexConfig({
    entityExtractionMode: "sidecar",
    salienceScoringMode: "sidecar",
    sidecar: {
      connectionProfileId: primaryId,
      model: "primary-model",
      temperature: 0.1,
      topP: 1,
      maxTokens: 4096,
      chunkBatchSize: 5,
      rebuildConcurrency: 3,
      requestsPerMinute: 0,
    },
    queryGeneration: {
      primary: { connectionProfileId: primaryId, model: "primary-model" },
      secondary: secondaryId ? { connectionProfileId: secondaryId, model: "secondary-model" } : null,
    },
  });
}

describe("memory-cortex routes secondary fallback", () => {
  test("resolves secondary when primary is unavailable", () => {
    connections.clear();
    connections.set("secondary-conn", {
      id: "secondary-conn",
      name: "Secondary",
      provider: "openai",
      model: "gpt",
      has_api_key: true,
    });

    const resolved = resolveCortexSidecarAdapter("user-1", configWith("missing-primary", "secondary-conn"));
    expect(resolved.unavailableReason).toBeUndefined();
    expect(resolved.sidecarConnectionId).toBe("secondary-conn");
    expect(typeof resolved.generateRawFn).toBe("function");
  });

  test("reports unavailable when every configured endpoint is missing a key", () => {
    connections.clear();
    connections.set("primary-conn", {
      id: "primary-conn",
      name: "Primary",
      provider: "openai",
      model: "gpt",
      has_api_key: false,
    });

    const resolved = resolveCortexSidecarAdapter("user-1", configWith("primary-conn"));
    expect(resolved.unavailableReason).toBe("sidecar_api_key_missing");
    expect(resolved.generateRawFn).toBeUndefined();

    const health = describeCortexSidecarHealth("user-1", configWith("primary-conn", null));
    expect(health.availability).toBe("unavailable");
    expect(health.queryGeneration.primary.unavailableReason).toBe("sidecar_api_key_missing");
  });

  test("describes primary and secondary endpoint health without leaking secrets", () => {
    connections.clear();
    connections.set("primary-conn", {
      id: "primary-conn",
      name: "Primary",
      provider: "openai",
      model: "gpt",
      has_api_key: true,
    });
    connections.set("secondary-conn", {
      id: "secondary-conn",
      name: "Secondary",
      provider: "openai",
      model: "gpt",
      has_api_key: true,
    });

    const health = describeCortexSidecarHealth("user-1", configWith("primary-conn", "secondary-conn"));
    expect(health.availability).toBe("ok");
    expect(health.queryGeneration.primary.ready).toBe(true);
    expect(health.queryGeneration.secondary?.ready).toBe(true);
    expect(JSON.stringify(health)).not.toContain("apiKey");
    expect(JSON.stringify(health)).not.toContain("secret");
  });
});
