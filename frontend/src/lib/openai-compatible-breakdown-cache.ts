export interface OpenAiCompatibleCacheUsageSummary {
  /** Anthropic-style cache reads, returned by some routed upstreams. */
  cacheReadInputTokens: number
  /** Anthropic-style cache writes, returned by some routed upstreams. */
  cacheCreationInputTokens: number
  /** OpenAI-style cache reads from Chat Completions or Responses usage. */
  cachedTokens: number
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function tokenDetailFrom(
  raw: Record<string, unknown>,
  field: string,
  key: 'cached_tokens' | 'cache_write_tokens',
): number {
  const details = raw[field]
  if (!details || typeof details !== 'object' || Array.isArray(details)) return 0
  return readNumber((details as Record<string, unknown>)[key])
}

/**
 * Cache telemetry exposed by direct OpenAI and OpenRouter's OpenAI-compatible
 * response path. OpenAI reports `input_tokens_details` for Responses and
 * `prompt_tokens_details` for Chat Completions; routed upstreams can use the
 * Anthropic-style fields instead.
 */
export function getOpenAiCompatibleCacheUsageSummary(
  provider: string,
  usage?: { provider_raw?: Record<string, unknown> },
): OpenAiCompatibleCacheUsageSummary | null {
  if (provider !== 'openai' && provider !== 'openrouter') return null
  const raw = usage?.provider_raw
  if (!raw || typeof raw !== 'object') return null

  const summary: OpenAiCompatibleCacheUsageSummary = {
    cacheReadInputTokens: readNumber(raw.cache_read_input_tokens),
    cacheCreationInputTokens:
      readNumber(raw.cache_creation_input_tokens) ||
      tokenDetailFrom(raw, 'prompt_tokens_details', 'cache_write_tokens') ||
      tokenDetailFrom(raw, 'input_tokens_details', 'cache_write_tokens'),
    cachedTokens:
      tokenDetailFrom(raw, 'prompt_tokens_details', 'cached_tokens') ||
      tokenDetailFrom(raw, 'input_tokens_details', 'cached_tokens'),
  }

  return summary.cacheReadInputTokens || summary.cacheCreationInputTokens || summary.cachedTokens
    ? summary
    : null
}
