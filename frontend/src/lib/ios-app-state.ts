import { hasIOSNativeBridge, iosNativeRequest } from './ios-native'

export type IOSAppState = 'active' | 'inactive' | 'background'

let currentState: IOSAppState | null = null
const listeners = new Set<(state: IOSAppState) => void>()
let stopTracking: (() => void) | null = null

/** UIKit is authoritative when WKWebView leaves visibility or focus stale. */
export function getIOSAppState(): IOSAppState | null {
  return hasIOSNativeBridge() ? currentState : null
}

export function subscribeIOSAppState(onChange: (state: IOSAppState) => void): () => void {
  if (!hasIOSNativeBridge()) return () => {}
  listeners.add(onChange)
  if (!stopTracking) {
    let stopped = false
    let eventRevision = 0, snapshotRevision = 0
    const publish = (value: unknown) => {
      if (stopped || !value || typeof value !== 'object') return
      const state = (value as { state?: unknown }).state
      if (state !== 'active' && state !== 'inactive' && state !== 'background') return
      currentState = state
      // Do not deduplicate active events: JS may have missed the preceding
      // background event while iOS was suspending the WebView.
      listeners.forEach(listener => listener(state))
    }
    const onState = (event: Event) => {
      eventRevision++
      publish((event as CustomEvent<unknown>).detail)
    }
    const refresh = () => {
      const eventAtRequest = eventRevision, request = ++snapshotRevision
      void iosNativeRequest<{ state?: unknown }>('lifecycle.status').then(value => {
        if (request === snapshotRevision && eventAtRequest === eventRevision && value?.state !== currentState) publish(value)
      }).catch(() => {})
    }
    window.addEventListener('lumiverse:ios-app-state', onState)
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', refresh)
    window.addEventListener('online', refresh)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh)
    // Native event delivery can fail while WebKit is suspended. Timers pause
    // with the app; once JS resumes this repairs a stale cached background state.
    const interval = setInterval(refresh, 15_000)
    stopTracking = () => {
      stopped = true
      window.removeEventListener('lumiverse:ios-app-state', onState)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pageshow', refresh)
      window.removeEventListener('online', refresh)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refresh)
      clearInterval(interval)
      currentState = null
      stopTracking = null
    }
    // Listen first and discard a delayed snapshot after a newer native event.
    // Older wrappers lack this action and retain the browser lifecycle path.
    refresh()
  } else if (currentState) {
    onChange(currentState)
  }
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0) stopTracking?.()
  }
}
