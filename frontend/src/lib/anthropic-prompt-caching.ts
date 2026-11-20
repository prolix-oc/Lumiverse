export type AnthropicPromptCachingTtl = '5m' | '1h'

export interface AnthropicPromptCachingBreakpoints {
  tools: boolean
  system: boolean
  messages: boolean
}

export interface AnthropicPromptCachingSettings {
  enabled: boolean
  automatic: boolean
  ttl: AnthropicPromptCachingTtl
  breakpoints: AnthropicPromptCachingBreakpoints
}

export const DEFAULT_ANTHROPIC_PROMPT_CACHING: AnthropicPromptCachingSettings = {
  enabled: false,
  automatic: true,
  ttl: '5m',
  breakpoints: {
    tools: false,
    system: false,
    messages: false,
  },
}

export function parseAnthropicPromptCachingSettings(value: unknown): AnthropicPromptCachingSettings {
  if (value === true) {
    return {
      ...DEFAULT_ANTHROPIC_PROMPT_CACHING,
      enabled: true,
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_ANTHROPIC_PROMPT_CACHING }
  }

  const record = value as Record<string, unknown>
  const breakpoints =
    record.breakpoints && typeof record.breakpoints === 'object' && !Array.isArray(record.breakpoints)
      ? record.breakpoints as Record<string, unknown>
      : {}

  return {
    enabled: true,
    automatic: record.automatic === false ? false : true,
    ttl: record.ttl === '1h' ? '1h' : '5m',
    breakpoints: {
      tools: breakpoints.tools === true,
      system: breakpoints.system === true,
      messages: breakpoints.messages === true,
    },
  }
}

export function buildAnthropicPromptCachingMetadata(settings: AnthropicPromptCachingSettings): false | Record<string, unknown> {
  if (!settings.enabled) return false

  const automatic = settings.automatic || !settings.breakpoints.tools && !settings.breakpoints.system && !settings.breakpoints.messages
  return {
    type: 'ephemeral',
    ...(settings.ttl === '1h' ? { ttl: '1h' } : {}),
    automatic,
    breakpoints: {
      ...(settings.breakpoints.tools ? { tools: true } : {}),
      ...(settings.breakpoints.system ? { system: true } : {}),
      ...(settings.breakpoints.messages ? { messages: true } : {}),
    },
  }
}

export function formatAnthropicPromptCachingSummary(value: unknown): string | null {
  const settings = parseAnthropicPromptCachingSettings(value)
  if (!settings.enabled) return null

  const labels: string[] = []
  if (settings.automatic) labels.push('auto')
  if (settings.breakpoints.tools) labels.push('tools')
  if (settings.breakpoints.system) labels.push('system')
  if (settings.breakpoints.messages) labels.push('messages')
  return `Cache ${settings.ttl}${labels.length > 0 ? ` • ${labels.join(' + ')}` : ''}`
}
