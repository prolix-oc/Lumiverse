import type { AppStore } from '@/types/store'
import { clearChatHeadsPersistence } from './slices/chat-heads'
import { clearUserDataJobPersistence } from './slices/user-data'
import { resetSettingsPersistence } from './slices/settings'
import { setPresetSaveCoordinatorScope } from '@/lib/loom/preset-save-coordinator'
import { clearLandingPageSnapshot } from '@/lib/landingPageSnapshot'
type StoreApi = {
  getState: () => AppStore
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
  resetSettingsPersistence()
  setPresetSaveCoordinatorScope(null)
  clearLandingPageSnapshot()
  if (!storeApi || !initialState) return
  clearUserDataJobPersistence(storeApi.getState().user?.id ?? null)

  const patch: Partial<AppStore> = {}

  for (const [key, value] of Object.entries(initialState)) {
    if (AUTH_STATE_KEYS.has(key)) continue
    if (typeof value === 'function') continue
    ;(patch as Record<string, unknown>)[key] = value
  }

  clearChatHeadsPersistence()
  patch.chatHeads = []
  patch.imageGenProfilesVersion = storeApi.getState().imageGenProfilesVersion + 1

  storeApi.setState(patch)
}
