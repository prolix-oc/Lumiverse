import type { StateCreator } from 'zustand'
import type { WorldInfoSlice } from '@/types/store'

export const createWorldInfoSlice: StateCreator<WorldInfoSlice> = (set) => ({
  activatedWorldInfo: [],
  worldInfoStats: null,
  setActivatedWorldInfo: (entries, stats) => set({ activatedWorldInfo: entries, worldInfoStats: stats ?? null }),
  clearActivatedWorldInfo: () => set({ activatedWorldInfo: [], worldInfoStats: null }),
})
