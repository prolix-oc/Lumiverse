import { isSafeWindowOpenTarget } from './navigationSafety'

let installed = false

export function installWindowOpenGuard(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  const nativeOpen = window.open.bind(window)

  window.open = ((url?: string | URL, target?: string, features?: string) => {
    if (url === undefined || url === null || url === '') {
      return nativeOpen(url, target, features)
    }

    const rawUrl = typeof url === 'string' ? url : url.toString()
    // SSO pre-opens an inert window during the user gesture, then assigns the
    // provider URL after the backend returns it. `about:blank` is the browser's
    // standard placeholder for that flow and cannot itself execute content.
    if (!isSafeWindowOpenTarget(rawUrl)) {
      console.warn('[navigation] Blocked unsafe window.open target:', rawUrl)
      return null
    }

    return nativeOpen(url, target, features)
  }) as typeof window.open
}
