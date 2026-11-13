export interface GenerationTimingSource {
  streamingStartedAt?: number;
  firstTokenAt?: number;
  firstContentTokenAt?: number;
  responseStoppedAt?: number;
  completedAt?: number;
  wasStreaming?: boolean;
}

export interface GenerationTimingMetrics {
  durationMs: number;
  wasStreaming: boolean;
  ttft?: number;
  tps?: number;
}

export interface GenerationTokenCounts {
  /** Authoritative generated-token count for message metadata. */
  messageTokenCount?: number;
  /** Visible response-token count used for response throughput. */
  responseTokenCount?: number;
}

export interface GenerationTokenCountOptions {
  hasReasoning?: boolean;
  /** Guided reasoning is counted as ordinary content by the provider. */
  hasDelimitedReasoning?: boolean;
  providerRaw?: Record<string, unknown>;
}

/**
 * Provider completion usage remains authoritative for message metadata. TPS
 * uses completion usage minus reported reasoning tokens, or a local visible
 * response count when reasoning cannot be separated from the provider total.
 * Local message and response counts are independent: finalized-message tokens
 * belong in the final report, and generated-response tokens belong in TPS.
 */
export function resolveGenerationTokenCounts(
  providerCompletionTokenCount: unknown,
  calculatedTokenCounts: GenerationTokenCounts = {},
  options: GenerationTokenCountOptions = {},
): GenerationTokenCounts {
  const normalizedProviderCount =
    typeof providerCompletionTokenCount === "number" &&
    Number.isFinite(providerCompletionTokenCount) &&
    providerCompletionTokenCount > 0
      ? Math.floor(providerCompletionTokenCount)
      : undefined;

  const details = options.providerRaw?.completion_tokens_details
    ?? options.providerRaw?.output_tokens_details;
  const reasoningTokenCount = typeof details === "object" && details !== null
    ? (details as Record<string, unknown>).reasoning_tokens
      ?? (details as Record<string, unknown>).thinking_tokens
    : undefined;

  let providerResponseTokenCount: number | undefined;
  if (!options.hasDelimitedReasoning) {
    if (
      normalizedProviderCount != null &&
      typeof reasoningTokenCount === "number" &&
      Number.isInteger(reasoningTokenCount) &&
      reasoningTokenCount >= 0 &&
      reasoningTokenCount <= normalizedProviderCount
    ) {
      providerResponseTokenCount = normalizedProviderCount - reasoningTokenCount;
    } else if (!options.hasReasoning && reasoningTokenCount == null) {
      providerResponseTokenCount = normalizedProviderCount;
    }
  }

  return {
    messageTokenCount: normalizedProviderCount ?? calculatedTokenCounts.messageTokenCount,
    responseTokenCount: providerResponseTokenCount ?? calculatedTokenCounts.responseTokenCount,
  };
}

/**
 * Calculate response timings. TTFT retains its historical meaning (the first
 * provider token, including reasoning), while TPS starts at the first
 * response-content token and ends at the provider's terminal stop, before
 * message persistence or deferred token counting. Its token count excludes
 * reasoning to match the measured response-content interval.
 */
export function calculateGenerationTimingMetrics(
  source: GenerationTimingSource,
  responseTokenCount?: number,
  observedAt = Date.now(),
): GenerationTimingMetrics {
  const wasStreaming = source.wasStreaming ?? true;
  const streamStart = source.streamingStartedAt;
  const responseEndedAt = source.completedAt ?? observedAt;
  const durationMs = streamStart
    ? Math.max(0, responseEndedAt - streamStart)
    : 0;

  let ttft: number | undefined;
  let tps: number | undefined;

  if (wasStreaming && streamStart) {
    if (source.firstTokenAt != null) {
      ttft = Math.max(0, source.firstTokenAt - streamStart);
    }

    if (source.firstContentTokenAt != null && source.responseStoppedAt != null && responseTokenCount && responseTokenCount > 1) {
      const responseDurationSec =
        (source.responseStoppedAt - source.firstContentTokenAt) / 1000;
      if (responseDurationSec > 0) {
        tps = Math.round((responseTokenCount / responseDurationSec) * 10) / 10;
      }
    }
  }

  return {
    durationMs,
    wasStreaming,
    ...(ttft != null ? { ttft } : {}),
    ...(tps != null ? { tps } : {}),
  };
}
