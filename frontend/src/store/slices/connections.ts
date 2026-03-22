import type { StateCreator } from 'zustand'
import type { ConnectionsSlice } from '@/types/store'
import { settingsApi } from '@/api/settings'

export const createConnectionsSlice: StateCreator<ConnectionsSlice> = (set) => ({
  profiles: [],
  activeProfileId: null,

  setProfiles: (profiles) => set({ profiles }),
  setActiveProfile: (id) => {
    set({ activeProfileId: id })
    settingsApi.put('activeProfileId', id).catch(() => {})
  },

  addProfile: (profile) => set((state) => ({ profiles: [...state.profiles, profile] })),
  updateProfile: (id, updates) =>
    set((state) => ({
      profiles: state.profiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),
  removeProfile: (id) =>
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== id),
      activeProfileId: state.activeProfileId === id ? null : state.activeProfileId,
    })),

  providers: [],
  setProviders: (providers) => set({ providers }),
})
