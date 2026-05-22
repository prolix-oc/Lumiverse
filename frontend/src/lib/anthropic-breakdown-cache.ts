import { parseAnthropicPromptCachingSettings } from './anthropic-prompt-caching'

export interface CacheHintEntry {
  kind: 'cached' | 'miss'
  label: string
}

export interface AnthropicCacheUsageSummary {
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  cacheCreation5mInputTokens: number
  cacheCreation1hInputTokens: number
}

export interface BreakdownCacheHintInput {
  provider: string
  parameters?: Record<string, unknown>
  breakdown: Array<{
    type: string
    role?: string
    messageCount?: number
    firstMessageIndex?: number
  }>
}

function isAnthropicCachingEnabled(provider: string, parameters?: Record<string, unknown>) {
  if (provider !== 'anthropic') return false
  return parseAnthropicPromptCachingSettings(parameters?.prompt_caching).enabled
}

export function getAnthropicBreakdownCacheHints(input: BreakdownCacheHintInput): CacheHintEntry[] {
  if (!isAnthropicCachingEnabled(input.provider, input.parameters)) return []

  const settings = parseAnthropicPromptCachingSettings(input.parameters?.prompt_caching)
  const lastChatHistoryIndex = (() => {
    for (let i = input.breakdown.length - 1; i >= 0; i--) {
      if (input.breakdown[i].type === 'chat_history') return i
    }
    return -1
  })()

  return input.breakdown.map((entry, index) => {
    if (settings.breakpoints.tools && entry.type === 'utility') {
      return { kind: 'cached', label: 'cached tools' }
    }
    if (settings.breakpoints.system && (entry.role === 'system' || entry.type === 'separator')) {
      return { kind: 'cached', label: 'cached system' }
    }
    if (settings.breakpoints.messages && index === lastChatHistoryIndex) {
      return { kind: 'cached', label: 'cached prefix' }
    }
    if (settings.automatic && index === input.breakdown.length - 1) {
      return { kind: 'cached', label: 'auto cache point' }
    }
    return { kind: 'miss', label: 'uncached' }
  })
}

export function getAnthropicCacheUsageSummary(
  provider: string,
  usage?: { provider_raw?: Record<string, unknown> },
): AnthropicCacheUsageSummary | null {
  if (provider !== 'anthropic') return null
  const raw = usage?.provider_raw
  if (!raw) return null

  const cacheCreation = raw.cache_creation && typeof raw.cache_creation === 'object' && !Array.isArray(raw.cache_creation)
    ? raw.cache_creation as Record<string, unknown>
    : {}

  return {
    cacheReadInputTokens: Number(raw.cache_read_input_tokens || 0),
    cacheCreationInputTokens: Number(raw.cache_creation_input_tokens || 0),
    cacheCreation5mInputTokens: Number(cacheCreation.ephemeral_5m_input_tokens || 0),
    cacheCreation1hInputTokens: Number(cacheCreation.ephemeral_1h_input_tokens || 0),
  }
}
