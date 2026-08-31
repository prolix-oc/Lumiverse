import type { StateCreator } from 'zustand'
import type { ActiveProfileSwitchReason, AppStore, ConnectionsSlice } from '@/types/store'
import type { ConnectionProfile } from '@/types/api'
import { settingsApi } from '@/api/settings'
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

export const createConnectionsSlice: StateCreator<AppStore, [], [], ConnectionsSlice> = (set, get) => ({
  profiles: [],
  activeProfileId: null,

  setProfiles: (profiles) => {
    const state = get()
    const nextProfiles = reorderProfiles(profiles, normalizeConnectionsOrder(state.connectionsOrder).llm)
    set({ profiles: nextProfiles })
    const activeProfileId = get().activeProfileId
    if (
      activeProfileId
      && !nextProfiles.some((profile) => profile.id === activeProfileId && profile.review_required !== true)
    ) {
      get().setActiveProfile(null, 'profile_invalidated')
    }
  },
  setActiveProfile: (id, reason = 'user_selection') => {
    const state = get()
    const oldProfile = state.activeProfileId
      ? state.profiles.find((p) => p.id === state.activeProfileId)
      : null
    const requestedProfile = id
      ? state.profiles.find((p) => p.id === id)
      : null
    // User and extension selections are closed operations: unknown and
    // review-required IDs resolve to no active profile. Cold-start bootstrap
    // hydration is the one exception because settings arrive before profiles;
    // setProfiles validates the pending id as soon as that snapshot lands.
    const pendingBootstrapId = reason === 'bootstrap_reconcile' && state.profiles.length === 0
      ? id
      : null
    const nextId = requestedProfile?.review_required === true
      ? null
      : requestedProfile?.id ?? pendingBootstrapId ?? null
    if (state.activeProfileId === nextId) return
    const newProfile = nextId
      ? state.profiles.find((p) => p.id === nextId)
      : null

    set({ activeProfileId: nextId })
    if (shouldPersistActiveProfileId(reason)) {
      settingsApi.put('activeProfileId', nextId).catch(() => {})
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

  addProfile: (profile) => {
    let orderToPersist: AppStore['connectionsOrder'] | null = null
    set((state) => {
      const connectionsOrder = normalizeConnectionsOrder(state.connectionsOrder)
      const order = connectionsOrder.llm
      const existingIndex = state.profiles.findIndex((candidate) => candidate.id === profile.id)
      const nextProfiles = existingIndex === -1
        ? [profile, ...state.profiles]
        : state.profiles.map((candidate, index) => index === existingIndex ? profile : candidate)
      const nextOrder = order.includes(profile.id) ? order : [profile.id, ...order]
      const nextConnectionsOrder = { ...connectionsOrder, llm: nextOrder }
      const active = nextProfiles.find((candidate) => candidate.id === state.activeProfileId)
      if (nextOrder !== order) orderToPersist = nextConnectionsOrder
      return {
        // A connection mutation is delivered both over WebSocket and in the
        // initiating request's REST response. Either can arrive first, so treat
        // adding an already-known id as an update instead of creating two rows.
        profiles: nextProfiles,
        activeProfileId: active?.review_required === true ? null : active?.id ?? null,
        connectionsOrder: nextConnectionsOrder,
      }
    })
    // Pickers and startup hydration use this setting rather than the transient
    // slice order, so a newly-prepended connection must update it as well.
    if (orderToPersist) persistKey('connectionsOrder', orderToPersist, 'state-sync')
  },
  updateProfile: (id, updates) =>
    set((state) => {
      const profiles = state.profiles.map((p) => (p.id === id ? { ...p, ...updates } : p))
      const active = profiles.find((p) => p.id === state.activeProfileId)
      return {
        profiles,
        activeProfileId: active?.review_required === true ? null : active?.id ?? null,
      }
    }),
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
