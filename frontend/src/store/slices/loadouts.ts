import type { StateCreator } from 'zustand'
import type { LoadoutsSlice } from '@/types/store'
import { loadoutsApi } from '@/api/loadouts'
import type { Loadout } from '@/api/loadouts'

export const createLoadoutsSlice: StateCreator<LoadoutsSlice> = (set, get) => ({
  loadouts: [],
  activeLoadoutId: null,
  loadoutsLoading: false,

  loadLoadouts: async () => {
    set({ loadoutsLoading: true })
    try {
      const loadouts = await loadoutsApi.list()
      set({ loadouts, loadoutsLoading: false })
    } catch {
      set({ loadoutsLoading: false })
    }
  },

  createLoadout: async (name: string) => {
    try {
      const loadout = await loadoutsApi.create(name)
      set((state) => ({ loadouts: [...state.loadouts, loadout] }))
      return loadout
    } catch {
      return null
    }
  },

  updateLoadout: async (id: string, updates: { name?: string; recapture?: boolean }) => {
    try {
      const updated = await loadoutsApi.update(id, updates)
      set((state) => ({
        loadouts: state.loadouts.map((l) => (l.id === id ? updated : l)),
      }))
    } catch {
      // noop
    }
  },

  deleteLoadout: async (id: string) => {
    try {
      await loadoutsApi.remove(id)
      set((state) => ({
        loadouts: state.loadouts.filter((l) => l.id !== id),
        activeLoadoutId: state.activeLoadoutId === id ? null : state.activeLoadoutId,
      }))
    } catch {
      // noop
    }
  },

  applyLoadout: async (id: string) => {
    try {
      await loadoutsApi.apply(id)
      set({ activeLoadoutId: id })
      // Reload settings to reflect the applied loadout values. Council is no
      // longer part of a loadout, so it is not reloaded here.
      const store = get() as any
      if (store.loadSettings) await store.loadSettings()
    } catch {
      // noop
    }
  },

  setActiveLoadoutId: (id: string | null) => set({ activeLoadoutId: id }),
})
