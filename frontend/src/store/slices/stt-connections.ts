import type { StateCreator } from 'zustand'
import type { SttConnectionsSlice } from '@/types/store'
import type { SttConnectionProfile } from '@/types/api'
import { normalizeConnectionsOrder } from './connections-order-merge'

export const createSttConnectionsSlice: StateCreator<SttConnectionsSlice> = (set) => ({
  sttProfiles: [],
  sttProviders: [],

  setSttProfiles: (profiles) => set({ sttProfiles: profiles }),

  addSttProfile: (profile) =>
    set((state) => {
      const connectionsOrder = normalizeConnectionsOrder((state as any).connectionsOrder)
      const order = connectionsOrder.stt
      return {
        sttProfiles: [...state.sttProfiles, profile],
        connectionsOrder: { ...connectionsOrder, stt: [...order, profile.id] },
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
