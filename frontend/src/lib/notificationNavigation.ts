import { getSafeInAppNavigationUrl } from './navigationSafety'

/** A plain chat notification only foregrounds an already displayed chat.
 * Explicit query/hash destinations still navigate so message links keep working.
 */
export function isCurrentChatNavigation(currentUrl: string, target: string): boolean {
  try {
    const current = new URL(currentUrl)
    const next = new URL(getSafeInAppNavigationUrl(target), current)
    return current.origin === next.origin
      && !next.search && !next.hash
      && /^\/chat\/[A-Za-z0-9_-]{1,128}\/?$/.test(next.pathname)
      && current.pathname.replace(/\/$/, '') === next.pathname.replace(/\/$/, '')
  } catch {
    return false
  }
}

export function navigateFromNotification(
  currentUrl: string,
  target: unknown,
  navigate: (path: string) => void,
): void {
  const path = getSafeInAppNavigationUrl(target)
  if (!isCurrentChatNavigation(currentUrl, path)) navigate(path)
}
