import { afterEach, describe, expect, test } from "bun:test";
import {
  CORTEX_SIDECAR_CIRCUIT_FAILURE_THRESHOLD,
  decideCortexSidecarFallback,
  isTransientCortexSidecarError,
  recordCortexSidecarCircuitOpenForTests,
  resetCortexSidecarCircuitForTests,
  runQueryGenerationSidecar,
} from "./index";
import { DEFAULT_CORTEX_CONFIG, normalizeCortexConfig, type MemoryCortexConfig } from "./config";

function configWith(overrides: Partial<MemoryCortexConfig> = {}): MemoryCortexConfig {
  return normalizeCortexConfig({
    ...DEFAULT_CORTEX_CONFIG,
    entityExtractionMode: "sidecar",
    salienceScoringMode: "sidecar",
    sidecar: {
      ...DEFAULT_CORTEX_CONFIG.sidecar,
      connectionProfileId: "primary-conn",
      model: "primary-model",
    },
    queryGeneration: {
      primary: { connectionProfileId: "primary-conn", model: "primary-model" },
      secondary: { connectionProfileId: "secondary-conn", model: "secondary-model" },
    },
    sidecarReliability: {
      ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
      fallback: "heuristic",
      maxRetries: 1,
      retryDelayMs: 1,
    },
    ...overrides,
  });
}

afterEach(() => {
  resetCortexSidecarCircuitForTests();
});

describe("runQueryGenerationSidecar", () => {
  test("uses primary when the first extract succeeds", async () => {
    const calls: string[] = [];
    const decision = await runQueryGenerationSidecar({
      userId: "user-1",
      config: configWith(),
      extract: async (target) => {
        calls.push(`${target.role}:${target.connectionProfileId}`);
        return { ok: true, role: target.role };
      },
    });

    expect(decision.status).toBe("ok");
    expect(decision.role).toBe("primary");
    expect(decision.persist).toBe(true);
    expect(decision.useHeuristic).toBe(false);
    expect(calls).toEqual(["primary:primary-conn"]);
  });

  test("fails over to secondary after primary retries exhaust", async () => {
    const calls: string[] = [];
    const decision = await runQueryGenerationSidecar({
      userId: "user-1",
      config: configWith(),
      extract: async (target) => {
        calls.push(`${target.role}:${target.attempt}`);
        if (target.role === "primary") throw new Error("503 upstream");
        return { ok: true };
      },
    });

    expect(decision.status).toBe("ok");
    expect(decision.role).toBe("secondary");
    expect(decision.persist).toBe(true);
    expect(decision.useHeuristic).toBe(false);
    expect(calls).toEqual(["primary:1", "primary:2", "secondary:1"]);
  });

  test("falls back to heuristic after primary and secondary fail", async () => {
    const decision = await runQueryGenerationSidecar({
      userId: "user-1",
      config: configWith({
        sidecarReliability: {
          ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
          fallback: "heuristic",
          maxRetries: 0,
          retryDelayMs: 0,
        },
      }),
      extract: async () => {
        throw new Error("503 upstream");
      },
    });

    expect(decision.status).toBe("exhausted");
    expect(decision.persist).toBe(true);
    expect(decision.useHeuristic).toBe(true);
  });

  test("skips persistence when fallback is skip", async () => {
    const decision = await runQueryGenerationSidecar({
      userId: "user-1",
      config: configWith({
        sidecarReliability: {
          ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
          fallback: "skip",
          maxRetries: 0,
          retryDelayMs: 0,
        },
      }),
      extract: async () => {
        throw new Error("503 upstream");
      },
    });

    expect(decision.status).toBe("exhausted");
    expect(decision.persist).toBe(false);
    expect(decision.useHeuristic).toBe(false);
  });

  test("caller cancellation during primary stops the chain without a memory write", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const pending = runQueryGenerationSidecar({
      userId: "user-1",
      config: configWith(),
      signal: controller.signal,
      extract: async (target) => {
        calls.push(target.role);
        controller.abort();
        throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      },
    });

    const decision = await pending;
    expect(decision.status).toBe("aborted");
    expect(decision.persist).toBe(false);
    expect(decision.useHeuristic).toBe(false);
    expect(calls).toEqual(["primary"]);
  });

  test("caller cancellation during retry stops the chain without a memory write", async () => {
    const controller = new AbortController();
    const calls: number[] = [];
    const decision = await runQueryGenerationSidecar({
      userId: "user-1",
      config: configWith({
        sidecarReliability: {
          ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
          fallback: "heuristic",
          maxRetries: 1,
          retryDelayMs: 30,
        },
      }),
      signal: controller.signal,
      extract: async (target) => {
        calls.push(target.attempt);
        controller.abort();
        throw new Error("503 upstream");
      },
    });

    expect(decision.status).toBe("aborted");
    expect(decision.persist).toBe(false);
    expect(decision.useHeuristic).toBe(false);
    expect(calls).toEqual([1]);
  });

  test("caller cancellation during secondary stops the chain without a memory write", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const decision = await runQueryGenerationSidecar({
      userId: "user-1",
      config: configWith({
        sidecarReliability: {
          ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
          fallback: "heuristic",
          maxRetries: 0,
          retryDelayMs: 0,
        },
      }),
      signal: controller.signal,
      extract: async (target) => {
        calls.push(target.role);
        if (target.role === "secondary") {
          controller.abort();
          throw Object.assign(new Error("Aborted"), { name: "AbortError" });
        }
        throw new Error("503 upstream");
      },
    });

    expect(decision.status).toBe("aborted");
    expect(decision.persist).toBe(false);
    expect(decision.useHeuristic).toBe(false);
    expect(calls).toEqual(["primary", "secondary"]);
  });

  test("does not invoke heuristic fallback after caller abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const extract = async () => {
      throw new Error("should not run");
    };
    const decision = await runQueryGenerationSidecar({
      userId: "user-1",
      config: configWith(),
      signal: controller.signal,
      extract,
    });

    expect(decision.status).toBe("aborted");
    expect(decision.useHeuristic).toBe(false);
    expect(decideCortexSidecarFallback(decision.status, "heuristic")).toEqual({
      persist: false,
      useHeuristic: false,
    });
  });

  test("skips an open circuit on primary and uses secondary", async () => {
    recordCortexSidecarCircuitOpenForTests("user-1", "primary-conn");
    const calls: string[] = [];
    const decision = await runQueryGenerationSidecar({
      userId: "user-1",
      config: configWith({
        sidecarReliability: {
          ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
          fallback: "skip",
          maxRetries: 0,
          retryDelayMs: 0,
        },
      }),
      extract: async (target) => {
        calls.push(target.role);
        return { ok: true };
      },
    });

    expect(decision.role).toBe("secondary");
    expect(calls).toEqual(["secondary"]);
  });

  test("classifies timeouts as transient and caller abort as not", () => {
    expect(isTransientCortexSidecarError(Object.assign(new Error("timed out"), { name: "AbortError" }), false)).toBe(true);
    expect(isTransientCortexSidecarError(Object.assign(new Error("Aborted"), { name: "AbortError" }), true)).toBe(false);
    expect(CORTEX_SIDECAR_CIRCUIT_FAILURE_THRESHOLD).toBeGreaterThan(0);
  });
});
