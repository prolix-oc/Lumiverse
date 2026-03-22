import type { StateCreator } from 'zustand'
import type { AppStore, PromptBreakdownSlice } from '@/types/store'

export const createPromptBreakdownSlice: StateCreator<AppStore, [], [], PromptBreakdownSlice> = (set) => ({
  breakdownCache: {},

  cacheBreakdown: (messageId, data) =>
    set((s) => ({
      breakdownCache: { ...s.breakdownCache, [messageId]: data },
    })),

  clearBreakdownsForChat: (chatId) =>
    set((s) => {
      const next: Record<string, any> = {}
      for (const [k, v] of Object.entries(s.breakdownCache)) {
        if (v?.chatId !== chatId) next[k] = v
      }
      return { breakdownCache: next }
    }),
})
