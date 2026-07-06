import type { StateCreator } from 'zustand'
import type { TtsConnectionsSlice } from '@/types/store'
import type { TtsConnectionProfile } from '@/types/api'
import { normalizeConnectionsOrder } from './connections-order-merge'

export const createTtsConnectionsSlice: StateCreator<TtsConnectionsSlice> = (set) => ({
  ttsProfiles: [],
  ttsProviders: [],

  setTtsProfiles: (profiles) => set({ ttsProfiles: profiles }),

  addTtsProfile: (profile) =>
    set((state) => {
      const connectionsOrder = normalizeConnectionsOrder((state as any).connectionsOrder)
      const order = connectionsOrder.tts
      return {
        ttsProfiles: [...state.ttsProfiles, profile],
        connectionsOrder: { ...connectionsOrder, tts: [...order, profile.id] },
      }
    }),

  updateTtsProfile: (id, updates) =>
    set((state) => ({
      ttsProfiles: state.ttsProfiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),

  removeTtsProfile: (id) =>
    set((state) => ({
      ttsProfiles: state.ttsProfiles.filter((p) => p.id !== id),
    })),

  applyTtsProfileOrder: (orderedIds) =>
    set((state) => ({
      ttsProfiles: orderedIds
        .map((id) => state.ttsProfiles.find((p) => p.id === id))
        .filter((p): p is TtsConnectionProfile => Boolean(p)),
    })),

  setTtsProviders: (providers) => set({ ttsProviders: providers }),
})
