import type { StateCreator } from 'zustand'
import type { WorldInfoSlice } from '@/types/store'

export const createWorldInfoSlice: StateCreator<WorldInfoSlice> = (set) => ({
  activatedWorldInfo: [],
  worldInfoStats: null,
  setActivatedWorldInfo: (entries, stats) => set({ activatedWorldInfo: entries, worldInfoStats: stats ?? null }),
  clearActivatedWorldInfo: () => set({ activatedWorldInfo: [], worldInfoStats: null }),
  pendingWorldBookEditId: null,
  setPendingWorldBookEditId: (id) => set({ pendingWorldBookEditId: id }),
  pendingWorldBookEditEntryId: null,
  setPendingWorldBookEditEntryId: (id) => set({ pendingWorldBookEditEntryId: id }),
  lorebookHalfEditor: { open: false, bookId: null, entryId: null },
  openLorebookHalfEditor: (bookId = null, entryId = null) => set({
    lorebookHalfEditor: { open: true, bookId, entryId },
  }),
  closeLorebookHalfEditor: () => set((state) => ({
    lorebookHalfEditor: { ...state.lorebookHalfEditor, open: false },
  })),
})
