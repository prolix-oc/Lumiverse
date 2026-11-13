import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { DEFAULT_INFERENCE_SCHEDULER_CONFIG } from "./config";
import type { InferenceSchedulerConfig } from "./types";

const store = new Map<string, unknown>();

mock.module("../settings.service", () => ({
  getSetting: (userId: string, key: string) => (
    store.has(`${userId}:${key}`) ? { key, value: store.get(`${userId}:${key}`) } : null
  ),
  putSetting: (userId: string, key: string, value: unknown) => {
    store.set(`${userId}:${key}`, value);
    return { key, value };
  },
}));

const configModule = await import("./config");

beforeEach(() => {
  store.clear();
  configModule.invalidateInferenceSchedulerConfig();
});

afterEach(() => {
  store.clear();
  configModule.resetInferenceSchedulerConfigForTests();
});

describe("inference scheduler config", () => {
  test("falls back to defaults for missing or malformed values", () => {
    expect(configModule.normalizeInferenceSchedulerConfig(null)).toEqual(DEFAULT_INFERENCE_SCHEDULER_CONFIG);
    expect(configModule.normalizeInferenceSchedulerConfig({ enabled: "yes", concurrency: 99 }).enabled).toBe(false);
    expect(configModule.normalizeInferenceSchedulerConfig({ concurrency: 99 }).concurrency).toBe(8);
    expect(configModule.normalizeInferenceSchedulerConfig({ concurrency: -3 }).concurrency).toBe(1);
    expect(configModule.normalizeInferenceSchedulerConfig({ maxWaitMs: -5 }).maxWaitMs).toBe(0);
  });

  test("normalizes and deduplicates origin lists", () => {
    const config = configModule.normalizeInferenceSchedulerConfig({
      extraOrigins: ["HTTP://LocalHost:8080/v1", "http://localhost:8080", "not a url"],
      excludedOrigins: ["https://api.openai.com/v1"],
    });
    expect(config.extraOrigins).toEqual(["http://localhost:8080"]);
    expect(config.excludedOrigins).toEqual(["https://api.openai.com"]);
  });

  test("normalizes groups, assigns ids, and drops empty groups", () => {
    const config = configModule.normalizeInferenceSchedulerConfig({
      groups: [
        { name: "Main GPU", origins: ["http://127.0.0.1:5001"] },
        { name: "Empty", origins: [] },
        { id: "Bad Id!", name: "Second", origins: ["http://127.0.0.1:8080"] },
      ],
    });
    expect(config.groups).toEqual([
      { id: "main-gpu", name: "Main GPU", origins: ["http://127.0.0.1:5001"] },
      { id: "bad-id", name: "Second", origins: ["http://127.0.0.1:8080"] },
    ]);
  });

  test("persists merged patches and invalidates the cached value", () => {
    const stored = configModule.putInferenceSchedulerConfig("user-a", {
      enabled: true,
      concurrency: 2,
    });
    expect(stored.enabled).toBe(true);
    expect(stored.concurrency).toBe(2);

    expect(configModule.getInferenceSchedulerConfig("user-a").enabled).toBe(true);

    configModule.putInferenceSchedulerConfig("user-a", { concurrency: 3 });
    expect(configModule.getInferenceSchedulerConfig("user-a").concurrency).toBe(3);
    expect(configModule.getInferenceSchedulerConfig("user-a").enabled).toBe(true);
  });

  test("rejects non-object patches", () => {
    expect(() => configModule.putInferenceSchedulerConfig("user-a", "nope" as unknown as never)).toThrow();
    expect(() => configModule.putInferenceSchedulerConfig("user-a", null as unknown as never)).toThrow();
  });

  test("isolates configuration per user", () => {
    configModule.putInferenceSchedulerConfig("user-a", { enabled: true });
    expect(configModule.getInferenceSchedulerConfig("user-b").enabled).toBe(false);
  });
});

function baseConfig(overrides: Partial<InferenceSchedulerConfig> = {}): InferenceSchedulerConfig {
  return {
    ...DEFAULT_INFERENCE_SCHEDULER_CONFIG,
    enabled: true,
    ...overrides,
  };
}

describe("inference scheduler config clamping helpers", () => {
  test("keeps aging disabled when explicitly zero", () => {
    expect(configModule.normalizeInferenceSchedulerConfig({ agingMs: 0 }).agingMs).toBe(0);
    expect(configModule.normalizeInferenceSchedulerConfig({ agingMs: 9_999_999 }).agingMs).toBe(600_000);
  });

  test("base config helper preserves defaults", () => {
    expect(baseConfig().unifiedLocalPool).toBe(true);
  });
});
