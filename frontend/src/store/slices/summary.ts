import type { StateCreator } from 'zustand'
import type { SummarySlice } from '@/types/store'
import { DEFAULT_SUMMARIZATION_SETTINGS } from '@/lib/summary/types'
import { settingsApi } from '@/api/settings'

export const createSummarySlice: StateCreator<SummarySlice> = (set) => ({
  summarization: { ...DEFAULT_SUMMARIZATION_SETTINGS },
  isSummarizing: false,

  setSummarization: (updates) =>
    set((state) => {
      const summarization = { ...state.summarization, ...updates }
      settingsApi.put('summarization', summarization).catch(() => {})
      return { summarization }
    }),

  setIsSummarizing: (value) => set({ isSummarizing: value }),
})
