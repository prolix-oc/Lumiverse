export interface NanoGptCacheUsageSummary {
  /** Tokens read from cache. >0 means at least one cache hit on this request. */
  cacheReadInputTokens: number
  /** Tokens written into cache this request (creation cost). */
  cacheCreationInputTokens: number
  /**
   * OpenAI-style cached token count (`prompt_tokens_details.cached_tokens`).
   * Some NanoGPT-routed providers (notably OpenAI/Gemini families under
   * implicit caching) report hits here instead of the Anthropic-style
   * `cache_read_input_tokens`. We surface both — whichever is non-zero is
   * the real signal.
   */
  cachedTokensOpenAiStyle: number
}

function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return 0
}

export function getNanoGptCacheUsageSummary(
  provider: string,
  usage?: { provider_raw?: Record<string, unknown> },
): NanoGptCacheUsageSummary | null {
  if (provider !== 'nanogpt') return null
  const raw = usage?.provider_raw
  if (!raw || typeof raw !== 'object') return null

  const details =
    typeof raw.prompt_tokens_details === 'object' &&
    raw.prompt_tokens_details !== null &&
    !Array.isArray(raw.prompt_tokens_details)
      ? (raw.prompt_tokens_details as Record<string, unknown>)
      : {}

  const summary: NanoGptCacheUsageSummary = {
    cacheReadInputTokens: readNumber(raw.cache_read_input_tokens),
    cacheCreationInputTokens: readNumber(raw.cache_creation_input_tokens),
    cachedTokensOpenAiStyle: readNumber(details.cached_tokens),
  }

  // Suppress the summary entirely when there's no caching signal at all —
  // avoids cluttering the UI for plain (non-cached) responses.
  if (
    summary.cacheReadInputTokens === 0 &&
    summary.cacheCreationInputTokens === 0 &&
    summary.cachedTokensOpenAiStyle === 0
  ) {
    return null
  }

  return summary
}
