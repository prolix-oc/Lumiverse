import { withRecentConnection } from '@/lib/connectionRecents'
import type { StateCreator } from 'zustand'
import type { ActiveProfileSwitchReason, AppStore, ConnectionsSlice } from '@/types/store'
import type { ConnectionProfile } from '@/types/api'
import { settingsApi } from '@/api/settings'
import { areReasoningSettingsEqual, normalizeReasoningSettingsForProvider } from '@/lib/reasoning-binding'
import { REASONING_DEFAULTS, clearDirtyKey, flushSettingsNow, persistKey } from './settings'
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

    const newBindings = newProfile?.metadata?.reasoningBindings?.settings
    const oldBindings = oldProfile?.metadata?.reasoningBindings?.settings
    // Legacy accounts have no separate preference yet. Capture their current
    // unbound settings before a binding or provider normalization replaces them.
    // Reconciliation has already hydrated the incoming connection's settings,
    // so it cannot capture the outgoing connection's preference.
    const captureUnbound = !oldBindings && !state.unboundReasoningSettings
      && reason === 'user_selection'
      && !!newProfile
    const unboundReasoningSettings = captureUnbound
      ? { ...state.reasoningSettings }
      : state.unboundReasoningSettings
    const preferredSettings = unboundReasoningSettings ?? (oldBindings ? REASONING_DEFAULTS : state.reasoningSettings)
    const nextReasoningSettings = newProfile
      ? normalizeReasoningSettingsForProvider(
        newBindings ?? preferredSettings,
        newProfile?.provider,
        newProfile?.model,
      )
      : { ...preferredSettings }
    const reasoningChanged = !areReasoningSettingsEqual(nextReasoningSettings, state.reasoningSettings)

    set({ activeProfileId: id, reasoningSettings: nextReasoningSettings, unboundReasoningSettings })
    if (reason === 'user_selection' && newProfile && state.fullSettingsLoaded !== false) {
      const recentConnections = withRecentConnection(state.recentConnections, 'llm', newProfile.id, state.connectionsPickerSettings?.recentProfileIds)
      get().setSetting('recentConnections', recentConnections, 'user-interaction')
    }
    if (shouldPersistActiveProfileId(reason)) {
      settingsApi.put('activeProfileId', id).catch(() => {})
    }
    if (captureUnbound) persistKey('unboundReasoningSettings', unboundReasoningSettings, 'state-sync')
    if (reasoningChanged) persistKey('reasoningSettings', nextReasoningSettings, 'state-sync')
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
    if (captureUnbound || reasoningChanged) {
      // Use the serialized settings queue so a pending edit cannot overwrite
      // the newly selected binding, and persist both settings together.
      void flushSettingsNow().catch(() => {})
    }
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
      }
    })
    // Pickers and startup hydration use this setting rather than the transient
    // slice order, so a newly-prepended connection must update it as well.
    if (orderToPersist) get().setSetting('connectionsOrder', orderToPersist, 'state-sync')
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
