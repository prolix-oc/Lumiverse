import type { StateCreator } from 'zustand'
import type { AppStore, SttConnectionsSlice } from '@/types/store'
import type { SttConnectionProfile } from '@/types/api'
import { persistKey } from './settings'
import { normalizeConnectionsOrder, reorderProfiles } from './connections-order-merge'

export const createSttConnectionsSlice: StateCreator<AppStore, [], [], SttConnectionsSlice> = (set, get) => ({
  sttProfiles: [],
  sttProviders: [],

  setSttProfiles: (profiles) => {
    const state = get()
    const sttProfiles = reorderProfiles(profiles, normalizeConnectionsOrder(state.connectionsOrder).stt)
    const selectedId = state.voiceSettings.sttConnectionId
    const sttConnectionId = selectedId && sttProfiles.some((profile) => profile.id === selectedId && profile.review_required !== true)
      ? selectedId
      : null
    set({ sttProfiles })
    if (sttConnectionId !== selectedId) get().setVoiceSettings({ sttConnectionId })
  },

  addSttProfile: (profile) => {
    const state = get()
    const existingIndex = state.sttProfiles.findIndex((candidate) => candidate.id === profile.id)
    const sttProfiles = existingIndex === -1
      ? [profile, ...state.sttProfiles]
      : state.sttProfiles.map((candidate, index) => index === existingIndex ? profile : candidate)
    const connectionsOrder = normalizeConnectionsOrder(state.connectionsOrder)
    const order = connectionsOrder.stt
    const nextOrder = order.includes(profile.id) ? order : [profile.id, ...order]
    const nextConnectionsOrder = { ...connectionsOrder, stt: nextOrder }
    const selectedId = state.voiceSettings.sttConnectionId
    const sttConnectionId = selectedId && sttProfiles.some((candidate) => candidate.id === selectedId && candidate.review_required !== true)
      ? selectedId
      : null
    set({ sttProfiles, connectionsOrder: nextConnectionsOrder })
    if (nextOrder !== order) persistKey('connectionsOrder', nextConnectionsOrder, 'state-sync')
    if (sttConnectionId !== selectedId) get().setVoiceSettings({ sttConnectionId })
  },

  updateSttProfile: (id, updates) => {
    const state = get()
    const sttProfiles = state.sttProfiles.map((p) => (p.id === id ? { ...p, ...updates } : p))
    set({ sttProfiles })
    if (state.voiceSettings.sttConnectionId === id && sttProfiles.some((profile) => profile.id === id && profile.review_required !== true)) return
    if (state.voiceSettings.sttConnectionId === id) get().setVoiceSettings({ sttConnectionId: null })
  },

  removeSttProfile: (id) => {
    const state = get()
    set({ sttProfiles: state.sttProfiles.filter((p) => p.id !== id) })
    if (state.voiceSettings.sttConnectionId === id) get().setVoiceSettings({ sttConnectionId: null })
  },

  applySttProfileOrder: (orderedIds) =>
    set((state) => ({
      sttProfiles: orderedIds
        .map((id) => state.sttProfiles.find((p) => p.id === id))
        .filter((p): p is SttConnectionProfile => Boolean(p)),
    })),

  setSttProviders: (providers) => set({ sttProviders: providers }),
})
