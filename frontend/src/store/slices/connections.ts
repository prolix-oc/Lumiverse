import type { StateCreator } from 'zustand'
import type { AppStore, ConnectionsSlice } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { REASONING_DEFAULTS, clearDirtyKey } from './settings'

export const createConnectionsSlice: StateCreator<AppStore, [], [], ConnectionsSlice> = (set, get) => ({
  profiles: [],
  activeProfileId: null,

  setProfiles: (profiles) => set({ profiles }),
  setActiveProfile: (id) => {
    const state = get()
    const oldProfile = state.activeProfileId
      ? state.profiles.find((p) => p.id === state.activeProfileId)
      : null
    const newProfile = id
      ? state.profiles.find((p) => p.id === id)
      : null

    set({ activeProfileId: id })
    settingsApi.put('activeProfileId', id).catch(() => {})

    // Apply or restore reasoning settings based on profile bindings
    const newBindings = newProfile?.metadata?.reasoningBindings?.settings
    const oldBindings = oldProfile?.metadata?.reasoningBindings?.settings

    if (newBindings) {
      // Switching TO a bound profile: apply its reasoning settings
      set({ reasoningSettings: { ...newBindings } } as any)
      settingsApi.put('reasoningSettings', { ...newBindings }).catch(() => {})
      clearDirtyKey('reasoningSettings')
    } else if (oldBindings) {
      // Switching FROM a bound profile TO an unbound one: restore defaults
      set({ reasoningSettings: { ...REASONING_DEFAULTS } } as any)
      settingsApi.put('reasoningSettings', { ...REASONING_DEFAULTS }).catch(() => {})
      clearDirtyKey('reasoningSettings')
    }
  },

  addProfile: (profile) => set((state) => ({ profiles: [...state.profiles, profile] })),
  updateProfile: (id, updates) =>
    set((state) => ({
      profiles: state.profiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),
  removeProfile: (id) => {
    const state = get()
    const wasActive = state.activeProfileId === id
    const removedProfile = wasActive ? state.profiles.find((p) => p.id === id) : null

    set((s) => ({
      profiles: s.profiles.filter((p) => p.id !== id),
      activeProfileId: s.activeProfileId === id ? null : s.activeProfileId,
    }))

    // If the removed profile was active and had reasoning bindings, restore defaults
    if (wasActive && removedProfile?.metadata?.reasoningBindings?.settings) {
      set({ reasoningSettings: { ...REASONING_DEFAULTS } } as any)
      settingsApi.put('reasoningSettings', { ...REASONING_DEFAULTS }).catch(() => {})
      clearDirtyKey('reasoningSettings')
    }
  },

  providers: [],
  setProviders: (providers) => set({ providers }),
})
