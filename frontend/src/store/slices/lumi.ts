import type { StateCreator } from 'zustand'
import type { LumiSlice } from '@/types/store'

export const createLumiSlice: StateCreator<LumiSlice> = (set) => ({
  lumiExecuting: false,
  lumiResults: [],
  lumiPipelineResult: null,

  setLumiExecuting: (executing) => set({ lumiExecuting: executing }),
  setLumiResults: (results) => set({ lumiResults: results }),
  addLumiResult: (result) => set((state) => ({ lumiResults: [...state.lumiResults, result] })),
  setLumiPipelineResult: (result) => set({ lumiPipelineResult: result }),
  clearLumiResults: () => set({ lumiResults: [], lumiPipelineResult: null }),
})
