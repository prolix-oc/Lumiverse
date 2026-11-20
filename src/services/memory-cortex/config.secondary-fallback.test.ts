import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CORTEX_CONFIG,
  migrateSidecarIntoEndpointPairs,
  normalizeCortexConfig,
  shouldUseCortexSidecar,
  shouldUseCortexSidecarForChunkAnalysis,
} from "./config";

describe("memory cortex primary/secondary config", () => {
  test("migrates sidecar.connectionProfileId/model into both primaries and preserves null secondary", () => {
    const migrated = migrateSidecarIntoEndpointPairs({
      connectionProfileId: "conn-primary",
      model: "gpt-test",
    });

    expect(migrated.queryGeneration.primary).toEqual({
      connectionProfileId: "conn-primary",
      model: "gpt-test",
    });
    expect(migrated.memorySummarization.primary).toEqual({
      connectionProfileId: "conn-primary",
      model: "gpt-test",
    });
    expect(migrated.queryGeneration.secondary).toBeNull();
    expect(migrated.memorySummarization.secondary).toBeNull();
  });

  test("normalizeCortexConfig migrates legacy sidecar-only payloads", () => {
    const normalized = normalizeCortexConfig({
      sidecar: {
        ...DEFAULT_CORTEX_CONFIG.sidecar,
        connectionProfileId: "legacy-conn",
        model: "legacy-model",
      },
    });

    expect(normalized.queryGeneration.primary.connectionProfileId).toBe("legacy-conn");
    expect(normalized.queryGeneration.primary.model).toBe("legacy-model");
    expect(normalized.memorySummarization.primary.connectionProfileId).toBe("legacy-conn");
    expect(normalized.memorySummarization.primary.model).toBe("legacy-model");
    expect(normalized.queryGeneration.secondary).toBeNull();
    expect(normalized.memorySummarization.secondary).toBeNull();
  });

  test("preserves an explicit secondary and does not invent one", () => {
    const normalized = normalizeCortexConfig({
      sidecar: {
        ...DEFAULT_CORTEX_CONFIG.sidecar,
        connectionProfileId: "primary-conn",
        model: "primary-model",
      },
      queryGeneration: {
        primary: { connectionProfileId: "primary-conn", model: "primary-model" },
        secondary: { connectionProfileId: "secondary-conn", model: "secondary-model" },
      },
      memorySummarization: {
        primary: { connectionProfileId: "primary-conn", model: "primary-model" },
        secondary: null,
      },
    });

    expect(normalized.queryGeneration.secondary).toEqual({
      connectionProfileId: "secondary-conn",
      model: "secondary-model",
    });
    expect(normalized.memorySummarization.secondary).toBeNull();
  });

  test("normalizes extra fallbacks after secondary without inventing hops", () => {
    const normalized = normalizeCortexConfig({
      sidecar: {
        ...DEFAULT_CORTEX_CONFIG.sidecar,
        connectionProfileId: "primary-conn",
        model: "primary-model",
      },
      queryGeneration: {
        primary: { connectionProfileId: "primary-conn", model: "primary-model" },
        secondary: { connectionProfileId: "secondary-conn", model: "secondary-model" },
        fallbacks: [
          { connectionProfileId: "secondary-conn", model: "dup" },
          { connectionProfileId: "tertiary-conn", model: "tertiary-model" },
          { connectionProfileId: null, model: "ignored" },
        ],
      },
    });

    expect(normalized.queryGeneration.secondary).toEqual({
      connectionProfileId: "secondary-conn",
      model: "secondary-model",
    });
    expect(normalized.queryGeneration.fallbacks).toEqual([
      { connectionProfileId: "tertiary-conn", model: "tertiary-model" },
    ]);
    expect(normalized.memorySummarization.secondary).toBeNull();
    expect(normalized.memorySummarization.fallbacks).toBeUndefined();
  });

  test("shouldUseCortexSidecar accepts queryGeneration primary without a sidecar field", () => {
    const config = normalizeCortexConfig({
      entityExtractionMode: "sidecar",
      queryGeneration: {
        primary: { connectionProfileId: "qg-conn", model: null },
        secondary: null,
      },
    });
    expect(shouldUseCortexSidecar(config)).toBe(true);
    expect(shouldUseCortexSidecarForChunkAnalysis(config)).toBe(true);
  });
});
