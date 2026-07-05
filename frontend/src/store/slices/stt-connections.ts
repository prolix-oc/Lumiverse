import type { StateCreator } from 'zustand'
import type { SttConnectionsSlice } from '@/types/store'
import type { SttConnectionProfile } from '@/types/api'

export const createSttConnectionsSlice: StateCreator<SttConnectionsSlice> = (set) => ({
  sttProfiles: [],
  sttProviders: [],

  setSttProfiles: (profiles) => set({ sttProfiles: profiles }),

  addSttProfile: (profile) =>
    set((state) => {
      const order = (state as any).connectionsOrder.stt as string[]
      return {
        sttProfiles: [...state.sttProfiles, profile],
        connectionsOrder: { ...(state as any).connectionsOrder, stt: [...order, profile.id] },
      }
    }),

  updateSttProfile: (id, updates) =>
    set((state) => ({
      sttProfiles: state.sttProfiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),

  removeSttProfile: (id) =>
    set((state) => ({
      sttProfiles: state.sttProfiles.filter((p) => p.id !== id),
    })),

  applySttProfileOrder: (orderedIds) =>
    set((state) => ({
      sttProfiles: orderedIds
        .map((id) => state.sttProfiles.find((p) => p.id === id))
        .filter((p): p is SttConnectionProfile => Boolean(p)),
    })),

  setSttProviders: (providers) => set({ sttProviders: providers }),
})
