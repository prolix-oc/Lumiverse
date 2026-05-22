import { isSafeBrowserNavigationTarget } from './navigationSafety'

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
    if (!isSafeBrowserNavigationTarget(rawUrl)) {
      console.warn('[navigation] Blocked unsafe window.open target:', rawUrl)
      return null
    }

    return nativeOpen(url, target, features)
  }) as typeof window.open
}
