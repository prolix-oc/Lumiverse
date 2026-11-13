import { expect, test } from "bun:test";
import {
  calculateGenerationTimingMetrics,
  resolveGenerationTokenCounts,
} from "./metrics";

test("message token count prefers provider usage over local tokenization", () => {
  expect(resolveGenerationTokenCounts(128, { messageTokenCount: 40, responseTokenCount: 40 })).toEqual({
    messageTokenCount: 128,
    responseTokenCount: 128,
  });
});

test("provider usage supplies token counts without local tokenization", () => {
  expect(resolveGenerationTokenCounts(128)).toEqual({
    messageTokenCount: 128,
    responseTokenCount: 128,
  });
});

test("message token count ignores invalid provider usage", () => {
  expect(resolveGenerationTokenCounts(undefined, { messageTokenCount: 40, responseTokenCount: 40 })).toEqual({
    messageTokenCount: 40,
    responseTokenCount: 40,
  });
  expect(resolveGenerationTokenCounts(0, { messageTokenCount: 40 }).messageTokenCount).toBe(40);
});

test.each([
  { completion_tokens_details: { reasoning_tokens: 108 } },
  { output_tokens_details: { reasoning_tokens: 108 } },
  { output_tokens_details: { thinking_tokens: 108 } },
])("provider reasoning breakdown separates response throughput from message totals: %j", (providerRaw) => {
  expect(resolveGenerationTokenCounts(128, undefined, { providerRaw })).toEqual({
    messageTokenCount: 128,
    responseTokenCount: 20,
  });
});

test("reasoning without a usage breakdown needs visible response tokenization", () => {
  expect(resolveGenerationTokenCounts(128, undefined, { hasReasoning: true })).toEqual({
    messageTokenCount: 128,
    responseTokenCount: undefined,
  });
  expect(resolveGenerationTokenCounts(128, { responseTokenCount: 40 }, { hasReasoning: true })).toEqual({
    messageTokenCount: 128,
    responseTokenCount: 40,
  });
});

test("guided reasoning cannot use a native reasoning-token breakdown", () => {
  expect(resolveGenerationTokenCounts(128, { responseTokenCount: 40 }, {
    hasDelimitedReasoning: true,
    providerRaw: { completion_tokens_details: { reasoning_tokens: 0 } },
  })).toEqual({ messageTokenCount: 128, responseTokenCount: 40 });
});

test("provider reasoning breakdown remains authoritative over local estimates", () => {
  expect(resolveGenerationTokenCounts(128, { responseTokenCount: 40 }, {
    hasReasoning: true,
    providerRaw: { completion_tokens_details: { reasoning_tokens: 108 } },
  })).toEqual({ messageTokenCount: 128, responseTokenCount: 20 });
});

test.each([-1, 129, 1.5, NaN, Infinity, "108"])("invalid reasoning usage falls back to visible tokenization: %j", (reasoning_tokens) => {
  const options = { providerRaw: { completion_tokens_details: { reasoning_tokens } } };
  expect(resolveGenerationTokenCounts(128, undefined, options).responseTokenCount).toBeUndefined();
  expect(resolveGenerationTokenCounts(128, { responseTokenCount: 40 }, options)).toEqual({
    messageTokenCount: 128,
    responseTokenCount: 40,
  });
});

test.each([undefined, 0])("final token report uses finalized-message tokens independently of TPS (provider usage: %j)", (providerCount) => {
  expect(resolveGenerationTokenCounts(providerCount, {
    messageTokenCount: 70,
    responseTokenCount: 40,
  }, { hasReasoning: true })).toEqual({
    messageTokenCount: 70,
    responseTokenCount: 40,
  });
});

test("response-only tokenization cannot supply the final token report", () => {
  expect(resolveGenerationTokenCounts(undefined, { responseTokenCount: 40 })).toEqual({
    messageTokenCount: undefined,
    responseTokenCount: 40,
  });
});

test("usage containing only reasoning has zero response tokens", () => {
  expect(resolveGenerationTokenCounts(128, undefined, {
    providerRaw: { completion_tokens_details: { reasoning_tokens: 128 } },
  })).toEqual({ messageTokenCount: 128, responseTokenCount: 0 });
});

test("TPS starts at visible response content and excludes reasoning time", () => {
  const metrics = calculateGenerationTimingMetrics(
    {
      streamingStartedAt: 1_000,
      firstTokenAt: 2_000,
      firstContentTokenAt: 5_000,
      responseStoppedAt: 7_000,
      completedAt: 7_000,
      wasStreaming: true,
    },
    40,
  );

  expect(metrics).toEqual({
    durationMs: 6_000,
    wasStreaming: true,
    ttft: 1_000,
    tps: 20,
  });
});

test("reasoning-only generations do not report visible-response TPS", () => {
  const metrics = calculateGenerationTimingMetrics(
    {
      streamingStartedAt: 1_000,
      firstTokenAt: 2_000,
      responseStoppedAt: 7_000,
      completedAt: 7_000,
      wasStreaming: true,
    },
    40,
  );

  expect(metrics.ttft).toBe(1_000);
  expect(metrics.tps).toBeUndefined();
});

test("non-streaming generations never report TTFT or TPS", () => {
  const metrics = calculateGenerationTimingMetrics({
    streamingStartedAt: 1_000,
    firstTokenAt: 2_000,
    firstContentTokenAt: 2_000,
    responseStoppedAt: 5_000,
    completedAt: 5_000,
    wasStreaming: false,
  }, 40);

  expect(metrics).toEqual({ durationMs: 4_000, wasStreaming: false });
});

test("message persistence and deferred metric work do not lower TPS", () => {
  const metrics = calculateGenerationTimingMetrics(
    {
      streamingStartedAt: 1_000,
      firstTokenAt: 2_000,
      firstContentTokenAt: 3_000,
      responseStoppedAt: 5_000,
      completedAt: 25_000,
      wasStreaming: true,
    },
    10,
    50_000,
  );

  expect(metrics.durationMs).toBe(24_000);
  expect(metrics.tps).toBe(5);
});

test("TPS needs both a provider content token and a terminal stop", () => {
  expect(calculateGenerationTimingMetrics({
    streamingStartedAt: 1_000,
    firstTokenAt: 2_000,
    firstContentTokenAt: 3_000,
    completedAt: 5_000,
  }, 10).tps).toBeUndefined();
  expect(calculateGenerationTimingMetrics({
    streamingStartedAt: 1_000,
    firstTokenAt: 2_000,
    responseStoppedAt: 5_000,
    completedAt: 5_000,
  }, 10).tps).toBeUndefined();
});
