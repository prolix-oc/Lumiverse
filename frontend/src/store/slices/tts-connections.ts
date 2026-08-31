import type { StateCreator } from 'zustand'
import type { AppStore, TtsConnectionsSlice } from '@/types/store'
import type { TtsConnectionProfile } from '@/types/api'
import { persistKey } from './settings'
import { normalizeConnectionsOrder, reorderProfiles } from './connections-order-merge'

export const createTtsConnectionsSlice: StateCreator<AppStore, [], [], TtsConnectionsSlice> = (set, get) => ({
  ttsProfiles: [],
  ttsProviders: [],

  setTtsProfiles: (profiles) => {
    const state = get()
    const ttsProfiles = reorderProfiles(profiles, normalizeConnectionsOrder(state.connectionsOrder).tts)
    const selectedId = state.voiceSettings.ttsConnectionId
    const ttsConnectionId = selectedId && ttsProfiles.some((profile) => profile.id === selectedId && profile.review_required !== true)
      ? selectedId
      : null
    set({ ttsProfiles })
    if (ttsConnectionId !== selectedId) get().setVoiceSettings({ ttsConnectionId })
  },

  addTtsProfile: (profile) => {
    const state = get()
    const existingIndex = state.ttsProfiles.findIndex((candidate) => candidate.id === profile.id)
    const ttsProfiles = existingIndex === -1
      ? [profile, ...state.ttsProfiles]
      : state.ttsProfiles.map((candidate, index) => index === existingIndex ? profile : candidate)
    const connectionsOrder = normalizeConnectionsOrder(state.connectionsOrder)
    const order = connectionsOrder.tts
    const nextOrder = order.includes(profile.id) ? order : [profile.id, ...order]
    const nextConnectionsOrder = { ...connectionsOrder, tts: nextOrder }
    const selectedId = state.voiceSettings.ttsConnectionId
    const ttsConnectionId = selectedId && ttsProfiles.some((candidate) => candidate.id === selectedId && candidate.review_required !== true)
      ? selectedId
      : null
    set({ ttsProfiles, connectionsOrder: nextConnectionsOrder })
    if (nextOrder !== order) persistKey('connectionsOrder', nextConnectionsOrder, 'state-sync')
    if (ttsConnectionId !== selectedId) get().setVoiceSettings({ ttsConnectionId })
  },

  updateTtsProfile: (id, updates) => {
    const state = get()
    const ttsProfiles = state.ttsProfiles.map((p) => (p.id === id ? { ...p, ...updates } : p))
    set({ ttsProfiles })
    if (state.voiceSettings.ttsConnectionId === id && ttsProfiles.some((profile) => profile.id === id && profile.review_required !== true)) return
    if (state.voiceSettings.ttsConnectionId === id) get().setVoiceSettings({ ttsConnectionId: null })
  },

  removeTtsProfile: (id) => {
    const state = get()
    set({ ttsProfiles: state.ttsProfiles.filter((p) => p.id !== id) })
    if (state.voiceSettings.ttsConnectionId === id) get().setVoiceSettings({ ttsConnectionId: null })
  },

  applyTtsProfileOrder: (orderedIds) =>
    set((state) => ({
      ttsProfiles: orderedIds
        .map((id) => state.ttsProfiles.find((p) => p.id === id))
        .filter((p): p is TtsConnectionProfile => Boolean(p)),
    })),

  setTtsProviders: (providers) => set({ ttsProviders: providers }),
})
