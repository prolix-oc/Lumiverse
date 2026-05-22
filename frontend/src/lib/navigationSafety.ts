const ABSOLUTE_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

function isRelativeNavigationTarget(value: string): boolean {
  return (
    (value.startsWith('/') && !value.startsWith('//')) ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('#') ||
    value.startsWith('?')
  )
}

export function isSafeBrowserNavigationTarget(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== 'string') return false

  const trimmed = rawUrl.trim()
  if (!trimmed) return false
  if (isRelativeNavigationTarget(trimmed)) return true
  if (!ABSOLUTE_SCHEME_RE.test(trimmed)) return false

  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function getSafeInAppNavigationUrl(rawUrl: unknown, fallback: string = '/'): string {
  if (typeof rawUrl !== 'string') return fallback

  const trimmed = rawUrl.trim()
  if (!trimmed) return fallback
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed

  return fallback
}

export function getSafeHttpsUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null

  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}
