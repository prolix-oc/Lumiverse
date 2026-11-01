import { getIOSAppState, subscribeIOSAppState } from './ios-app-state'
import { createForegroundSync } from './foreground-sync'

export function isIOSForeground() {
  const state = getIOSAppState()
  return state ? state === 'active' : document.visibilityState !== 'hidden'
}

export function createIOSForegroundSync(sync: (signal: AbortSignal) => Promise<void>, pollMs?: number) {
  return createForegroundSync(sync, pollMs, { foreground: isIOSForeground, subscribe: subscribeIOSAppState })
}
