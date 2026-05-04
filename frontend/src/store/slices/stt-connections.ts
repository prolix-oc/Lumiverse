import type { StateCreator } from 'zustand'
import type { SttConnectionsSlice } from '@/types/store'

export const createSttConnectionsSlice: StateCreator<SttConnectionsSlice> = (set) => ({
  sttProfiles: [],
  sttProviders: [],

  setSttProfiles: (profiles) => set({ sttProfiles: profiles }),

  addSttProfile: (profile) =>
    set((state) => ({ sttProfiles: [...state.sttProfiles, profile] })),

  updateSttProfile: (id, updates) =>
    set((state) => ({
      sttProfiles: state.sttProfiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),

  removeSttProfile: (id) =>
    set((state) => ({
      sttProfiles: state.sttProfiles.filter((p) => p.id !== id),
    })),

  setSttProviders: (providers) => set({ sttProviders: providers }),
})
