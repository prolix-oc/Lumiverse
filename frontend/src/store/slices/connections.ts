import type { StateCreator } from 'zustand'
import type { ActiveProfileSwitchReason, AppStore, ConnectionsSlice } from '@/types/store'
import type { ConnectionProfile } from '@/types/api'
import { settingsApi } from '@/api/settings'
import { ApiError } from '@/api/client'
import { characterConnectionBindsApi } from '@/api/character-connection-binds'
import { areReasoningSettingsEqual, normalizeReasoningSettingsForProvider } from '@/lib/reasoning-binding'
import { REASONING_DEFAULTS, clearDirtyKey, persistKey } from './settings'
import { normalizeConnectionsOrder, reorderProfiles } from './connections-order-merge'

const PERSISTED_ACTIVE_PROFILE_REASONS: ReadonlySet<ActiveProfileSwitchReason> = new Set([
  'user_selection',
  'profile_deleted',
  'profile_invalidated',
])

export function shouldPersistActiveProfileId(reason: ActiveProfileSwitchReason): boolean {
  return PERSISTED_ACTIVE_PROFILE_REASONS.has(reason)
}

// Both setActiveChat and setActiveCharacter fire for a single chat open, so
// the character-bind fetch is memoized by character id. The memo is module
// state (like the chat slice's stream buffers) and must be cleared by the
// user-scoped reset — see resetCharacterConnectionBindHydration.
let hydratedCharacterBindFor: string | null = null

// Monotonic sequence bumped by every activeCharacterConnectionId write made
// through setActiveCharacterConnection (toggle UI, WS push). Hydration
// captures the sequence when its GET leaves and discards a response that
// resolves after a newer write, so a slow fetch can't clobber a fresher
// local/server write for the same character.
let characterBindWriteSeq = 0

/** Reset the character-bind hydration memo (logout / user switch). */
export function resetCharacterConnectionBindHydration(): void {
  hydratedCharacterBindFor = null
}

export const createConnectionsSlice: StateCreator<AppStore, [], [], ConnectionsSlice> = (set, get) => ({
  profiles: [],
  activeProfileId: null,
  activeCharacterConnectionId: null,

  setProfiles: (profiles) => {
    set((state) => ({
      profiles: reorderProfiles(profiles, normalizeConnectionsOrder(state.connectionsOrder).llm),
    }))
    const activeProfileId = get().activeProfileId
    if (activeProfileId && !profiles.some((profile) => profile.id === activeProfileId)) {
      get().setActiveProfile(null, 'profile_invalidated')
    }
  },
  setActiveProfile: (id, reason = 'user_selection') => {
    const state = get()
    if (state.activeProfileId === id) return
    const oldProfile = state.activeProfileId
      ? state.profiles.find((p) => p.id === state.activeProfileId)
      : null
    const newProfile = id
      ? state.profiles.find((p) => p.id === id)
      : null

    set({ activeProfileId: id })
    if (shouldPersistActiveProfileId(reason)) {
      settingsApi.put('activeProfileId', id).catch(() => {})
    }

    // Apply or restore reasoning settings based on profile bindings
    const newBindings = newProfile?.metadata?.reasoningBindings?.settings
    const oldBindings = oldProfile?.metadata?.reasoningBindings?.settings

    if (newBindings) {
      // Switching TO a bound profile: apply its reasoning settings
      const normalizedBindings = normalizeReasoningSettingsForProvider(newBindings, newProfile?.provider, newProfile?.model)
      set({ reasoningSettings: normalizedBindings } as any)
      settingsApi.put('reasoningSettings', normalizedBindings).catch(() => {})
      clearDirtyKey('reasoningSettings')
    } else if (oldBindings) {
      // Switching FROM a bound profile TO an unbound one: restore defaults
      set({ reasoningSettings: { ...REASONING_DEFAULTS } } as any)
      settingsApi.put('reasoningSettings', { ...REASONING_DEFAULTS }).catch(() => {})
      clearDirtyKey('reasoningSettings')
    } else if (newProfile) {
      // Switching between unbound profiles: keep the current settings, but map
      // provider-specific effort tiers onto the new provider's supported scale.
      const normalizedCurrent = normalizeReasoningSettingsForProvider(state.reasoningSettings, newProfile.provider, newProfile.model)
      if (!areReasoningSettingsEqual(normalizedCurrent, state.reasoningSettings)) {
        set({ reasoningSettings: normalizedCurrent } as any)
        settingsApi.put('reasoningSettings', normalizedCurrent).catch(() => {})
        clearDirtyKey('reasoningSettings')
      }
    }

    // Apply or restore promptBias ("Start Reply With") when bound on the profile
    const newBoundPromptBias = newProfile?.metadata?.reasoningBindings?.promptBias
    const oldBoundPromptBias = oldProfile?.metadata?.reasoningBindings?.promptBias
    if (typeof newBoundPromptBias === 'string') {
      set({ promptBias: newBoundPromptBias } as any)
      settingsApi.put('promptBias', newBoundPromptBias).catch(() => {})
      clearDirtyKey('promptBias')
    } else if (typeof oldBoundPromptBias === 'string') {
      set({ promptBias: '' } as any)
      settingsApi.put('promptBias', '').catch(() => {})
      clearDirtyKey('promptBias')
    }
  },

  setActiveCharacterConnection: (id) => {
    characterBindWriteSeq += 1
    set({ activeCharacterConnectionId: id })
  },

  hydrateActiveCharacterConnection: (characterId, opts) => {
    if (!characterId) {
      hydratedCharacterBindFor = null
      set({ activeCharacterConnectionId: null })
      return
    }
    if (!opts?.force && hydratedCharacterBindFor === characterId && get().activeCharacterId === characterId) return
    const previous = hydratedCharacterBindFor
    hydratedCharacterBindFor = characterId
    // Switching characters: drop the previous character's bind immediately so
    // a slow (or failed) fetch can't present it as the new character's.
    if (previous !== characterId) set({ activeCharacterConnectionId: null })
    const writeSeqAtFetch = characterBindWriteSeq
    characterConnectionBindsApi.get(characterId)
      .then((result) => {
        if (get().activeCharacterId !== characterId) return
        // A write landed while the GET was in flight — it is fresher than
        // this response, so don't clobber it.
        if (characterBindWriteSeq !== writeSeqAtFetch) return
        set({ activeCharacterConnectionId: result.connection_id })
      })
      .catch((err) => {
        if (get().activeCharacterId !== characterId) return
        // 404 = unknown character, i.e. no binding. Other failures keep the
        // current value but clear the memo so a later attempt retries.
        if (err instanceof ApiError && err.status === 404) {
          if (characterBindWriteSeq === writeSeqAtFetch) set({ activeCharacterConnectionId: null })
          return
        }
        hydratedCharacterBindFor = null
        console.error('[connections] Failed to hydrate character connection bind:', err)
      })
  },

  addProfile: (profile) => {
    let orderToPersist: AppStore['connectionsOrder'] | null = null
    set((state) => {
      const connectionsOrder = normalizeConnectionsOrder(state.connectionsOrder)
      const order = connectionsOrder.llm
      const existingIndex = state.profiles.findIndex((candidate) => candidate.id === profile.id)
      const nextOrder = order.includes(profile.id) ? order : [profile.id, ...order]
      const nextConnectionsOrder = { ...connectionsOrder, llm: nextOrder }
      if (nextOrder !== order) orderToPersist = nextConnectionsOrder
      return {
        // A connection mutation is delivered both over WebSocket and in the
        // initiating request's REST response. Either can arrive first, so treat
        // adding an already-known id as an update instead of creating two rows.
        profiles: existingIndex === -1
          ? [profile, ...state.profiles]
          : state.profiles.map((candidate, index) => index === existingIndex ? profile : candidate),
        connectionsOrder: nextConnectionsOrder,
      }
    })
    // Pickers and startup hydration use this setting rather than the transient
    // slice order, so a newly-prepended connection must update it as well.
    if (orderToPersist) persistKey('connectionsOrder', orderToPersist, 'state-sync')
  },
  updateProfile: (id, updates) =>
    set((state) => ({
      profiles: state.profiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),
  removeProfile: (id) => {
    const wasActive = get().activeProfileId === id
    if (wasActive) get().setActiveProfile(null, 'profile_deleted')
    set((s) => ({
      profiles: s.profiles.filter((p) => p.id !== id),
    }))
  },

  applyProfileOrder: (orderedIds) =>
    set((state) => ({
      profiles: orderedIds
        .map((id) => state.profiles.find((p) => p.id === id))
        .filter((p): p is ConnectionProfile => Boolean(p)),
    })),

  providers: [],
  setProviders: (providers) => set({ providers }),
})
