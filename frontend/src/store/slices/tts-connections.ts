import type { StateCreator } from 'zustand'
import type { TtsConnectionsSlice } from '@/types/store'

export const createTtsConnectionsSlice: StateCreator<TtsConnectionsSlice> = (set) => ({
  ttsProfiles: [],
  ttsProviders: [],

  setTtsProfiles: (profiles) => set({ ttsProfiles: profiles }),

  addTtsProfile: (profile) =>
    set((state) => ({ ttsProfiles: [...state.ttsProfiles, profile] })),

  updateTtsProfile: (id, updates) =>
    set((state) => ({
      ttsProfiles: state.ttsProfiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),

  removeTtsProfile: (id) =>
    set((state) => ({
      ttsProfiles: state.ttsProfiles.filter((p) => p.id !== id),
    })),

  setTtsProviders: (providers) => set({ ttsProviders: providers }),
})
