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

/** Allow the inert placeholder used to reserve an SSO popup during a user
 * gesture without admitting other non-web schemes as navigation targets. */
export function isSafeWindowOpenTarget(rawUrl: unknown): rawUrl is string {
  return rawUrl === 'about:blank' || isSafeBrowserNavigationTarget(rawUrl)
}

export function getSafeInAppNavigationUrl(rawUrl: unknown, fallback: string = '/'): string {
  if (typeof rawUrl !== 'string') return fallback

  const trimmed = rawUrl.trim()
  if (!trimmed) return fallback
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback

  // Lumiverse uses a browser router. Older built-in notifications and some
  // extensions still use the former hash-router form (`/#/chat/:id`), so
  // canonicalize it before passing it to router.navigate() or openWindow().
  if (trimmed.startsWith('/#/')) return `/${trimmed.slice(3)}`

  return trimmed

}

export function getSafeHttpsUrl(rawUrl: unknown): string | null {
  const url = getSafeHttpOrHttpsUrl(rawUrl)
  return url?.startsWith('https:') ? url : null
}

export function getSafeHttpOrHttpsUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null

  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}
