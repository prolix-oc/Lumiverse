import type { StateCreator } from 'zustand'
import type { AppStore, TtsConnectionsSlice } from '@/types/store'
import type { TtsConnectionProfile } from '@/types/api'
import { normalizeConnectionsOrder, reorderProfiles } from './connections-order-merge'

export const createTtsConnectionsSlice: StateCreator<AppStore, [], [], TtsConnectionsSlice> = (set) => ({
  ttsProfiles: [],
  ttsProviders: [],

  setTtsProfiles: (profiles) =>
    set((state) => ({
      ttsProfiles: reorderProfiles(profiles, normalizeConnectionsOrder(state.connectionsOrder).tts),
    })),

  addTtsProfile: (profile) =>
    set((state) => {
      const connectionsOrder = normalizeConnectionsOrder(state.connectionsOrder)
      const order = connectionsOrder.tts
      const existingIndex = state.ttsProfiles.findIndex((candidate) => candidate.id === profile.id)
      return {
        ttsProfiles: existingIndex === -1
          ? [profile, ...state.ttsProfiles]
          : state.ttsProfiles.map((candidate, index) => index === existingIndex ? profile : candidate),
        connectionsOrder: {
          ...connectionsOrder,
          tts: order.includes(profile.id) ? order : [profile.id, ...order],
        },
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
