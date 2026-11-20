import { getSafeHttpOrHttpsUrl, getSafeHttpsUrl } from './navigationSafety'

export interface AuthorizationPopupOptions {
  name?: string
  features?: string
}

export interface AuthorizationNavigationOptions {
  /** SSO completion uses window.opener to report its result. External linking
   * flows should retain the safer default and disconnect the opener. */
  preserveOpener?: boolean
  /** Self-hosted LumiHub and development SSO providers may explicitly use
   * HTTP. Illarin remains HTTPS-only by leaving this disabled. */
  allowHttp?: boolean
}

export type AuthorizationNavigationResult =
  | { status: 'popup'; url: string }
  | { status: 'blocked'; url: string }
  | { status: 'invalid' }

/** Reserve a browsing context while the initiating click still has user
 * activation. The explicit placeholder also matches Tauri's native popup
 * contract on every desktop platform. */
export function reserveAuthorizationPopup(
  options: AuthorizationPopupOptions = {},
): Window | null {
  try {
    return window.open('about:blank', options.name ?? '_blank', options.features)
  } catch {
    return null
  }
}

/** Safely navigate a reserved authorization window. A blocked result leaves
 * the caller in control of whether to use same-tab navigation or show a link. */
export function navigateAuthorizationPopup(
  popup: Window | null,
  rawUrl: unknown,
  options: AuthorizationNavigationOptions = {},
): AuthorizationNavigationResult {
  const url = options.allowHttp
    ? getSafeHttpOrHttpsUrl(rawUrl)
    : getSafeHttpsUrl(rawUrl)
  if (!url) return { status: 'invalid' }

  try {
    if (!popup || popup.closed) return { status: 'blocked', url }
    popup.location.href = url

    if (!options.preserveOpener) {
      // Navigation has already been queued, so a platform-specific opener
      // setter failure must not prevent the authorization page from opening.
      try { popup.opener = null } catch {}
    }
    try { popup.focus() } catch {}
    return { status: 'popup', url }
  } catch {
    closeAuthorizationPopup(popup)
    return { status: 'blocked', url }
  }
}

export function closeAuthorizationPopup(popup: Window | null): void {
  try { popup?.close() } catch {}
}
