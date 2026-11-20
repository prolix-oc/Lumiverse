import type { StateCreator } from 'zustand'
import type { AppStore, DecisionConnectionsSlice } from '@/types/store'
import type { DecisionConnectionProfile } from '@/types/api'
import { normalizeConnectionsOrder, reorderProfiles } from './connections-order-merge'

export const createDecisionConnectionsSlice: StateCreator<AppStore, [], [], DecisionConnectionsSlice> = (set, get) => ({
  decisionProfiles: [],
  decisionProviders: [],

  setDecisionProfiles: (profiles) =>
    set((state) => ({
      decisionProfiles: reorderProfiles(profiles, normalizeConnectionsOrder(state.connectionsOrder).decision),
    })),

  addDecisionProfile: (profile) => {
    let orderToPersist: AppStore['connectionsOrder'] | null = null
    set((state) => {
      const connectionsOrder = normalizeConnectionsOrder(state.connectionsOrder)
      const order = connectionsOrder.decision
      const existingIndex = state.decisionProfiles.findIndex((candidate) => candidate.id === profile.id)
      const nextOrder = order.includes(profile.id) ? order : [profile.id, ...order]
      const nextConnectionsOrder = { ...connectionsOrder, decision: nextOrder }
      if (nextOrder !== order) orderToPersist = nextConnectionsOrder
      return {
        decisionProfiles: existingIndex === -1
          ? [profile, ...state.decisionProfiles]
          : state.decisionProfiles.map((candidate, index) => index === existingIndex ? profile : candidate),
      }
    })
    if (orderToPersist) get().setSetting('connectionsOrder', orderToPersist, 'state-sync')
  },

  updateDecisionProfile: (id, updates) =>
    set((state) => ({
      decisionProfiles: state.decisionProfiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),

  removeDecisionProfile: (id) =>
    set((state) => ({
      decisionProfiles: state.decisionProfiles.filter((p) => p.id !== id),
    })),

  applyDecisionProfileOrder: (orderedIds) =>
    set((state) => ({
      decisionProfiles: orderedIds
        .map((id) => state.decisionProfiles.find((p) => p.id === id))
        .filter((p): p is DecisionConnectionProfile => Boolean(p)),
    })),

  setDecisionProviders: (providers) => set({ decisionProviders: providers }),
})
