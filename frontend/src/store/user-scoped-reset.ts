import type { AppStore } from '@/types/store'
import { clearChatHeadsPersistence } from './slices/chat-heads'

type StoreApi = {
  setState: (partial: Partial<AppStore>) => void
}

let storeApi: StoreApi | null = null
let initialState: AppStore | null = null

const AUTH_STATE_KEYS = new Set([
  'user',
  'session',
  'isAuthenticated',
  'isAuthLoading',
  'authError',
])

export function registerUserScopedResetStore(api: StoreApi, initial: AppStore): void {
  storeApi = api
  initialState = initial
}

export function resetUserScopedStoreState(): void {
  if (!storeApi || !initialState) return

  const patch: Partial<AppStore> = {}

  for (const [key, value] of Object.entries(initialState)) {
    if (AUTH_STATE_KEYS.has(key)) continue
    if (typeof value === 'function') continue
    ;(patch as Record<string, unknown>)[key] = value
  }

  clearChatHeadsPersistence()
  patch.chatHeads = []

  storeApi.setState(patch)
}
