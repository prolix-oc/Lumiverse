/**
 * Reproducible micro-benchmarks for the local-inference scheduler.
 *
 *   INFERENCE_SCHEDULER_BENCHMARK=1 bun test src/services/inference-scheduler/scheduler.benchmark.test.ts
 *
 * The benchmark reports:
 * - admission overhead per request when scheduling is disabled (the default),
 * - how long 100 one-millisecond tasks take when serialized through one queue,
 * - the same work released together when scheduling is disabled.
 */
import { afterEach, expect, test } from "bun:test";

import { DEFAULT_INFERENCE_SCHEDULER_CONFIG } from "./config";
import { __test__, withInferenceLease } from "./scheduler";

const ENDPOINT = "http://127.0.0.1:5001/v1/chat/completions";
const USER = "benchmark-user";

async function gatedWork(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

afterEach(() => {
  __test__.reset();
});

test.skipIf(process.env.INFERENCE_SCHEDULER_BENCHMARK !== "1")(
  "admission overhead and serialized throughput",
  async () => {
    __test__.setHost(true);
    __test__.setConfig({ ...DEFAULT_INFERENCE_SCHEDULER_CONFIG, enabled: false });

    const disabledStartedAt = performance.now();
    await Promise.all(
      Array.from({ length: 100 }, () =>
        withInferenceLease(
          { userId: USER, endpoint: ENDPOINT, requestClass: "bulk" },
          () => gatedWork(1),
        ),
      ),
    );
    const disabledMs = performance.now() - disabledStartedAt;

    const overheadStartedAt = performance.now();
    for (let index = 0; index < 2_000; index += 1) {
      await withInferenceLease(
        { userId: USER, endpoint: ENDPOINT, requestClass: "background" },
        async () => {},
      );
    }
    const overheadMs = performance.now() - overheadStartedAt;

    __test__.setConfig({
      ...DEFAULT_INFERENCE_SCHEDULER_CONFIG,
      enabled: true,
      unifiedLocalPool: true,
      concurrency: 1,
      preemptBackground: false,
    });

    const scheduledStartedAt = performance.now();
    await Promise.all(
      Array.from({ length: 100 }, () =>
        withInferenceLease(
          { userId: USER, endpoint: ENDPOINT, requestClass: "bulk" },
          () => gatedWork(1),
        ),
      ),
    );
    const scheduledMs = performance.now() - scheduledStartedAt;

    console.log(
      [
        "",
        "[inference-scheduler benchmark]",
        `  100 × 1ms tasks, unscheduled: ${disabledMs.toFixed(1)}ms`,
        `  100 × 1ms tasks, one queue:  ${scheduledMs.toFixed(1)}ms`,
        `  admission overhead:          ${(overheadMs / 2_000 * 1_000).toFixed(1)}µs/request`,
        "",
      ].join("\n"),
    );

    expect(overheadMs / 2_000).toBeLessThan(5);
    expect(scheduledMs).toBeGreaterThanOrEqual(disabledMs);
  },
);
