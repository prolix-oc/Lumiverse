import { describe, expect, test } from "bun:test";

import { DEFAULT_INFERENCE_SCHEDULER_CONFIG } from "./config";
import { resolveInferenceResource } from "./resources";
import type { InferenceSchedulerConfig } from "./types";

function config(overrides: Partial<InferenceSchedulerConfig> = {}): InferenceSchedulerConfig {
  return {
    ...DEFAULT_INFERENCE_SCHEDULER_CONFIG,
    enabled: true,
    ...overrides,
  };
}

describe("inference resource resolution", () => {
  test("is disabled for remote endpoints", () => {
    expect(resolveInferenceResource(config(), "https://api.openai.com")).toBeNull();
  });

  test("unifies every local endpoint by default", () => {
    const first = resolveInferenceResource(config(), "http://127.0.0.1:5001");
    const second = resolveInferenceResource(config(), "http://127.0.0.1:8080");
    expect(first?.key).toBe("local:unified");
    expect(second?.key).toBe(first?.key);
  });

  test("splits endpoints into per-origin queues when the unified pool is off", () => {
    const split = config({ unifiedLocalPool: false });
    expect(resolveInferenceResource(split, "http://127.0.0.1:5001")?.key).toBe("origin:http://127.0.0.1:5001");
    expect(resolveInferenceResource(split, "http://127.0.0.1:8080")?.key).toBe("origin:http://127.0.0.1:8080");
  });

  test("named groups merge origins across the unified setting", () => {
    const grouped = config({
      unifiedLocalPool: false,
      groups: [{ id: "gpu", name: "Main GPU", origins: ["http://127.0.0.1:5001", "http://127.0.0.1:8080"] }],
    });
    expect(resolveInferenceResource(grouped, "http://127.0.0.1:5001")?.key).toBe("group:gpu");
    expect(resolveInferenceResource(grouped, "http://127.0.0.1:8080")?.key).toBe("group:gpu");
  });

  test("extra origins schedule remote endpoints and exclusions always win", () => {
    const extra = config({ extraOrigins: ["https://gpu.example.com"] });
    expect(resolveInferenceResource(extra, "https://gpu.example.com")?.key).toBe("local:unified");

    const excluded = config({ excludedOrigins: ["http://127.0.0.1:8188"] });
    expect(resolveInferenceResource(excluded, "http://127.0.0.1:8188")).toBeNull();
  });
});
