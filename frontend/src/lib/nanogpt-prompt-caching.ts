export type NanoGptCachingTtl = '5m' | '1h'

export interface NanoGptCachingSettings {
  enabled: boolean
  ttl: NanoGptCachingTtl
  stickyProvider: boolean
}

export const DEFAULT_NANOGPT_CACHING: NanoGptCachingSettings = {
  enabled: false,
  ttl: '5m',
  stickyProvider: true,
}

export function parseNanoGptCachingSettings(value: unknown): NanoGptCachingSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_NANOGPT_CACHING }
  }
  const record = value as Record<string, unknown>
  if (record.enabled !== true) {
    return { ...DEFAULT_NANOGPT_CACHING }
  }
  return {
    enabled: true,
    ttl: record.ttl === '1h' ? '1h' : '5m',
    stickyProvider: record.stickyProvider === false ? false : true,
  }
}

export function buildNanoGptCachingMetadata(settings: NanoGptCachingSettings): false | Record<string, unknown> {
  if (!settings.enabled) return false
  return {
    enabled: true,
    ttl: settings.ttl,
    stickyProvider: settings.stickyProvider,
  }
}

export function formatNanoGptCachingSummary(value: unknown): string | null {
  const settings = parseNanoGptCachingSettings(value)
  if (!settings.enabled) return null
  return `Cache ${settings.ttl}${settings.stickyProvider ? ' • sticky' : ''}`
}
