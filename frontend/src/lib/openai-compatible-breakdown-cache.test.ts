import { describe, expect, test } from 'bun:test'

import { getOpenAiCompatibleCacheUsageSummary } from './openai-compatible-breakdown-cache'

describe('getOpenAiCompatibleCacheUsageSummary', () => {
  test('reads Chat Completions cached-token telemetry for OpenAI', () => {
    expect(getOpenAiCompatibleCacheUsageSummary('openai', {
      provider_raw: { prompt_tokens_details: { cached_tokens: 1200 } },
    })).toEqual({ cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cachedTokens: 1200 })
  })

  test('reads Responses cached-token telemetry for OpenAI', () => {
    expect(getOpenAiCompatibleCacheUsageSummary('openai', {
      provider_raw: { input_tokens_details: { cached_tokens: 3200 } },
    })).toEqual({ cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cachedTokens: 3200 })
  })

  test('reads routed cache telemetry for OpenRouter', () => {
    expect(getOpenAiCompatibleCacheUsageSummary('openrouter', {
      provider_raw: {
        prompt_tokens_details: { cached_tokens: 500, cache_write_tokens: 100 },
      },
    })).toEqual({ cacheReadInputTokens: 0, cacheCreationInputTokens: 100, cachedTokens: 500 })
  })

  test('does not surface unrelated providers or empty telemetry', () => {
    expect(getOpenAiCompatibleCacheUsageSummary('nanogpt', {
      provider_raw: { prompt_tokens_details: { cached_tokens: 1 } },
    })).toBeNull()
    expect(getOpenAiCompatibleCacheUsageSummary('openrouter', { provider_raw: {} })).toBeNull()
  })
})
