/** Mobile Tauri has its own lifecycle and exposes no desktop tray/window commands. */
export function isTauriMobile(): boolean {
  return typeof window !== 'undefined' && (
    (window as Window & { __LUMIVERSE_MOBILE__?: boolean }).__LUMIVERSE_MOBILE__ === true
    || (typeof document !== 'undefined' && document.documentElement?.hasAttribute('data-tauri-mobile') === true)
  )
}

/** The native marker distinguishes iOS WebKit from the Android mobile host. */
export function getTauriMobilePlatform(): 'ios' | 'android' | null {
  if (!isTauriMobile()) return null
  const native = (window as Window & { __LUMIVERSE_PLATFORM__?: string }).__LUMIVERSE_PLATFORM__
  const marker = typeof document !== 'undefined' ? document.documentElement?.getAttribute('data-tauri-mobile') : null
  return native === 'ios' || marker === 'ios' ? 'ios' : 'android'
}

export function hasTauriDesktopBridge(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !isTauriMobile()
}

/** Whether this document is running in any native Tauri desktop shell. */
export function isTauriDesktop(): boolean {
  return typeof document !== 'undefined'
    && document.documentElement.hasAttribute('data-tauri-desktop')
    && !isTauriMobile()
}

/** Native hosts configure media playback without a browser gesture gate. */
export function isTauriWebView(): boolean {
  return isTauriMobile() || isTauriDesktop()
}

/** Whether this document is running in the macOS Tauri WKWebView shell. */
export function isMacTauriWebView(): boolean {
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  return isTauriDesktop()
    && root.getAttribute('data-platform') === 'macos'
}
