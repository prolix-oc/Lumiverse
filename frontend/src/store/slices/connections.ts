import type { StateCreator } from 'zustand'
import type { ActiveProfileSwitchReason, AppStore, ConnectionsSlice } from '@/types/store'
import type { ConnectionProfile } from '@/types/api'
import { settingsApi } from '@/api/settings'
import { areReasoningSettingsEqual, normalizeReasoningSettingsForProvider } from '@/lib/reasoning-binding'
import { REASONING_DEFAULTS, clearDirtyKey } from './settings'
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

  addProfile: (profile) => set((state) => {
    const connectionsOrder = normalizeConnectionsOrder(state.connectionsOrder)
    const order = connectionsOrder.llm
    const existingIndex = state.profiles.findIndex((candidate) => candidate.id === profile.id)
    return {
      // A connection mutation is delivered both over WebSocket and in the
      // initiating request's REST response. Either can arrive first, so treat
      // adding an already-known id as an update instead of creating two rows.
      profiles: existingIndex === -1
        ? [profile, ...state.profiles]
        : state.profiles.map((candidate, index) => index === existingIndex ? profile : candidate),
      connectionsOrder: {
        ...connectionsOrder,
        llm: order.includes(profile.id) ? order : [profile.id, ...order],
      },
    }
  }),
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
