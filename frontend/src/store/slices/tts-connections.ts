import type { StateCreator } from 'zustand'
import type { TtsConnectionsSlice } from '@/types/store'
import type { TtsConnectionProfile } from '@/types/api'

export const createTtsConnectionsSlice: StateCreator<TtsConnectionsSlice> = (set) => ({
  ttsProfiles: [],
  ttsProviders: [],

  setTtsProfiles: (profiles) => set({ ttsProfiles: profiles }),

  addTtsProfile: (profile) =>
    set((state) => {
      const order = (state as any).connectionsOrder.tts as string[]
      return {
        ttsProfiles: [...state.ttsProfiles, profile],
        connectionsOrder: { ...(state as any).connectionsOrder, tts: [...order, profile.id] },
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
