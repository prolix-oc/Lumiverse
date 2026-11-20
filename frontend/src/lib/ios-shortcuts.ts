import { hasIOSNativeBridge, iosNativeRequest } from './ios-native'

export type IOSShortcutAction = 'resume-chat' | 'favorites'
interface ShortcutRequest { id: string; action: IOSShortcutAction }
const identifier = /^[A-Za-z0-9_-]{1,128}$/
const storageKey = (accountId: string) => `lumiverse.ios.last-chat.v1:${accountId}`

// localStorage is already scoped to the selected server's origin. Store only
// an opaque ID, separately for each account; never store conversation content.
export function rememberIOSChat(accountId: string, chatId: string | null): void {
  if (!chatId || !identifier.test(chatId)) return
  try { localStorage.setItem(storageKey(accountId), chatId) } catch { /* Storage can be unavailable. */ }
}

export function lastIOSChat(accountId: string): string | null {
  try {
    const value = localStorage.getItem(storageKey(accountId))
    return value && identifier.test(value) ? value : null
  } catch { return null }
}

function isRequest(value: unknown): value is ShortcutRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<ShortcutRequest>
  return typeof request.id === 'string' && /^[A-Fa-f0-9-]{36}$/.test(request.id)
    && (request.action === 'resume-chat' || request.action === 'favorites')
}

/** Subscribe only after auth and startup settings are ready. Acknowledging the
 * exact request after navigation preserves cold launches and newer invocations. */
export function installIOSShortcuts(handle: (action: IOSShortcutAction) => boolean): () => void {
  if (!hasIOSNativeBridge()) return () => {}
  let stopped = false, running = false, refreshAgain = false
  let handledId: string | null = null
  const refresh = () => {
    if (stopped) return
    if (running) { refreshAgain = true; return }
    running = true
    void (async () => {
      do {
        refreshAgain = false
        const request = await iosNativeRequest<unknown>('shortcuts.pending')
        if (stopped) return
        if (!isRequest(request)) {
          if (refreshAgain) continue
          return
        }
        if (request.id !== handledId) {
          if (!handle(request.action)) return
          handledId = request.id
        }
        await iosNativeRequest('shortcuts.ack', { id: request.id })
      } while (!stopped && refreshAgain)
    })().catch(() => { /* Older wrappers lack shortcuts; retry on the next foreground event. */ })
      .finally(() => { running = false })
  }
  const onVisibility = () => { if (document.visibilityState === 'visible') refresh() }
  const onAppState = (event: Event) => {
    if ((event as CustomEvent<{ state?: string }>).detail?.state === 'active') refresh()
  }
  window.addEventListener('lumiverse:ios-shortcut', refresh)
  window.addEventListener('lumiverse:ios-app-state', onAppState)
  window.addEventListener('pageshow', refresh)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', onVisibility)
  refresh()
  return () => {
    stopped = true
    window.removeEventListener('lumiverse:ios-shortcut', refresh)
    window.removeEventListener('lumiverse:ios-app-state', onAppState)
    window.removeEventListener('pageshow', refresh)
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
