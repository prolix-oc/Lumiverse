export type NanoGptCachingTtl = '5m' | '1h'

export interface NanoGptCachingSettings {
  enabled: boolean
  ttl: NanoGptCachingTtl
  stickyProvider: boolean
  /**
   * Optional message index that NanoGPT should treat as the cache cutoff.
   * Anything from index 0 up to and including this index is eligible for
   * caching. Omit to let NanoGPT decide.
   */
  cutAfterMessageIndex?: number
  /**
   * When true, NanoGPT respects user-provided inline `cache_control` markers
   * in the request body instead of auto-injecting its own breakpoints.
   * Defaults to false on the wire when unset.
   */
  explicitCacheControl?: boolean
  /**
   * Advanced. When true, sends top-level `caching: true` so NanoGPT routes
   * to a cache-capable upstream regardless of model. May bypass
   * subscription coverage per NanoGPT docs — opt-in only.
   */
  forceCacheCapableRouting?: boolean
}

export const DEFAULT_NANOGPT_CACHING: NanoGptCachingSettings = {
  enabled: false,
  ttl: '5m',
  stickyProvider: true,
}

function readCutAfter(record: Record<string, unknown>): number | undefined {
  const raw = record.cutAfterMessageIndex ?? record.cut_after_message_index
  if (typeof raw !== 'number') return undefined
  if (!Number.isInteger(raw) || raw < 0) return undefined
  return raw
}

function readExplicitCacheControl(record: Record<string, unknown>): boolean | undefined {
  const raw = record.explicitCacheControl ?? record.explicit_cache_control
  return raw === true ? true : undefined
}

function readForceCacheCapableRouting(record: Record<string, unknown>): boolean | undefined {
  const raw = record.forceCacheCapableRouting ?? record.force_cache_capable_routing
  return raw === true ? true : undefined
}

export function parseNanoGptCachingSettings(value: unknown): NanoGptCachingSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_NANOGPT_CACHING }
  }
  const record = value as Record<string, unknown>
  if (record.enabled !== true) {
    // Preserve disabled state but still pick up any stored advanced fields so
    // re-enabling restores the user's last config.
    return {
      ...DEFAULT_NANOGPT_CACHING,
      ttl: record.ttl === '1h' ? '1h' : '5m',
      stickyProvider: record.stickyProvider === false ? false : true,
      ...(readCutAfter(record) !== undefined ? { cutAfterMessageIndex: readCutAfter(record) } : {}),
      ...(readExplicitCacheControl(record) !== undefined ? { explicitCacheControl: true } : {}),
      ...(readForceCacheCapableRouting(record) !== undefined ? { forceCacheCapableRouting: true } : {}),
    }
  }
  const cutAfter = readCutAfter(record)
  const explicit = readExplicitCacheControl(record)
  const force = readForceCacheCapableRouting(record)
  return {
    enabled: true,
    ttl: record.ttl === '1h' ? '1h' : '5m',
    stickyProvider: record.stickyProvider === false ? false : true,
    ...(cutAfter !== undefined ? { cutAfterMessageIndex: cutAfter } : {}),
    ...(explicit !== undefined ? { explicitCacheControl: true } : {}),
    ...(force !== undefined ? { forceCacheCapableRouting: true } : {}),
  }
}

export function buildNanoGptCachingMetadata(settings: NanoGptCachingSettings): false | Record<string, unknown> {
  if (!settings.enabled) return false
  const out: Record<string, unknown> = {
    enabled: true,
    ttl: settings.ttl,
    stickyProvider: settings.stickyProvider,
  }
  if (
    typeof settings.cutAfterMessageIndex === 'number' &&
    Number.isInteger(settings.cutAfterMessageIndex) &&
    settings.cutAfterMessageIndex >= 0
  ) {
    out.cutAfterMessageIndex = settings.cutAfterMessageIndex
  }
  if (settings.explicitCacheControl === true) {
    out.explicitCacheControl = true
  }
  if (settings.forceCacheCapableRouting === true) {
    out.forceCacheCapableRouting = true
  }
  return out
}

export function formatNanoGptCachingSummary(value: unknown): string | null {
  const settings = parseNanoGptCachingSettings(value)
  if (!settings.enabled) return null
  const parts = [`Cache ${settings.ttl}`]
  if (settings.stickyProvider) parts.push('sticky')
  if (typeof settings.cutAfterMessageIndex === 'number') {
    parts.push(`cut@${settings.cutAfterMessageIndex}`)
  }
  if (settings.explicitCacheControl) parts.push('explicit')
  if (settings.forceCacheCapableRouting) parts.push('force route')
  return parts.join(' • ')
}
