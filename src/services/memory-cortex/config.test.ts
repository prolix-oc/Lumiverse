import { expect, test } from "bun:test";
import { DEFAULT_CORTEX_CONFIG, isCortexEnabledForChat, normalizeCortexConfig, shouldReviewCortexCandidates, shouldUseCortexSidecar } from "./config";

test("legacy retry settings are discarded while configured fallback connections survive", () => {
  const legacy = {
    ...DEFAULT_CORTEX_CONFIG,
    sidecarReliability: { ...DEFAULT_CORTEX_CONFIG.sidecarReliability, maxRetries: 10, retryDelayMs: 500 },
    queryGeneration: {
      primary: { connectionProfileId: "primary", model: "test" },
      secondary: { connectionProfileId: "secondary", model: "test" },
    },
  };
  const config = normalizeCortexConfig(legacy);
  expect(config.sidecarReliability).not.toHaveProperty("maxRetries");
  expect(config.sidecarReliability).not.toHaveProperty("retryDelayMs");
  expect(config.queryGeneration).toMatchObject(legacy.queryGeneration);
});

test("candidate review and existing-record cleanup require an explicit boolean opt-in", () => {
  expect(DEFAULT_CORTEX_CONFIG.sidecarReliability.arbitratesHeuristics).toBe(false);
  expect(DEFAULT_CORTEX_CONFIG.sidecarReliability.gradesExistingRecords).toBe(false);
  expect(normalizeCortexConfig({ enabled: true }).sidecarReliability).toMatchObject({
    arbitratesHeuristics: false, gradesExistingRecords: false,
  });

  for (const value of [undefined, null, false, "false", "true", 0, 1, {}, [], true]) {
    const sidecarReliability = {
      ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
      arbitratesHeuristics: value,
      gradesExistingRecords: value,
    } as unknown as typeof DEFAULT_CORTEX_CONFIG.sidecarReliability;
    expect(normalizeCortexConfig({ arbitration: DEFAULT_CORTEX_CONFIG.arbitration, sidecarReliability }).sidecarReliability).toMatchObject({
      arbitratesHeuristics: value === true, gradesExistingRecords: value === true,
    });
  }
});

test("candidate review stays inactive until a Decision connection is explicitly selected", () => {
  const config = normalizeCortexConfig({ ...DEFAULT_CORTEX_CONFIG, sidecarReliability: {
    ...DEFAULT_CORTEX_CONFIG.sidecarReliability, arbitratesHeuristics: true,
  } });
  expect(config.arbitration).toMatchObject({ backend: "decision", connectionProfileId: null, model: null });
  expect(shouldReviewCortexCandidates(config)).toBe(false);
  const selected = { ...config, arbitration: { ...config.arbitration, connectionProfileId: "decision-a" } };
  expect(shouldReviewCortexCandidates(selected)).toBe(true);
  expect(shouldUseCortexSidecar({ ...selected, sidecar: { ...selected.sidecar, connectionProfileId: "unused-llm" },
    consolidation: { ...selected.consolidation, enabled: false }, entityExtractionMode: "heuristic", salienceScoringMode: "heuristic" })).toBe(false);
});

test("legacy generative reviewer settings are disabled and cleared without reusing their connection", () => {
  for (const backend of ["sidecar", undefined]) {
    const config = normalizeCortexConfig({ ...DEFAULT_CORTEX_CONFIG,
      sidecarReliability: { ...DEFAULT_CORTEX_CONFIG.sidecarReliability, arbitratesHeuristics: true },
      arbitration: { ...DEFAULT_CORTEX_CONFIG.arbitration, backend, connectionProfileId: "old-llm", model: "old-model" },
    } as unknown as Parameters<typeof normalizeCortexConfig>[0]);
    expect(config.sidecarReliability.arbitratesHeuristics).toBe(false);
    expect(config.arbitration).toMatchObject({ backend: "decision", connectionProfileId: null, model: null });
  }
});

test("existing explicit Decision reviewer selections and overrides survive normalization", () => {
  const config = normalizeCortexConfig({ ...DEFAULT_CORTEX_CONFIG,
    sidecarReliability: { ...DEFAULT_CORTEX_CONFIG.sidecarReliability, arbitratesHeuristics: true },
    arbitration: { ...DEFAULT_CORTEX_CONFIG.arbitration, connectionProfileId: "decision-a", model: "chosen-model" },
  });
  expect(config.sidecarReliability.arbitratesHeuristics).toBe(true);
  expect(config.arbitration).toMatchObject({ backend: "decision", connectionProfileId: "decision-a", model: "chosen-model" });
});

test("chat Cortex opt-out inherits global config unless explicitly disabled", () => {
  expect(isCortexEnabledForChat({ enabled: true }, {})).toBe(true);
  expect(isCortexEnabledForChat({ enabled: true }, { cortex_settings: {} })).toBe(true);
  expect(isCortexEnabledForChat({ enabled: true }, { cortex_settings: { enabled: false } })).toBe(false);
  expect(isCortexEnabledForChat({ enabled: true }, { cortex_settings: { enabled: true } })).toBe(true);
  expect(isCortexEnabledForChat({ enabled: false }, { cortex_settings: { enabled: true } })).toBe(false);
  expect(isCortexEnabledForChat({ enabled: true }, { temporary: true })).toBe(false);
  expect(isCortexEnabledForChat({ enabled: true }, { temporary: true, cortex_settings: { enabled: true } })).toBe(false);
});

test("Decision review defaults to a 16K input window and bounds local-server overrides", () => {
  expect(normalizeCortexConfig({}).arbitration.maxInputTokens).toBe(16384);
  expect(normalizeCortexConfig({ arbitration: { ...DEFAULT_CORTEX_CONFIG.arbitration, maxInputTokens: 4096 } }).arbitration.maxInputTokens).toBe(4096);
  expect(normalizeCortexConfig({ arbitration: { ...DEFAULT_CORTEX_CONFIG.arbitration, maxInputTokens: -1 } }).arbitration.maxInputTokens).toBe(1024);
});
