import type { StateCreator } from 'zustand'
import type { AppStore, DatabankSlice } from '@/types/store'

export const createDatabankSlice: StateCreator<AppStore, [], [], DatabankSlice> = (set) => ({
  databanks: [],
  databankDocuments: [],
  selectedDatabankId: null,
  databankScopeFilter: 'global',
  databankScopeCharacterId: null,

  setDatabanks: (banks) => set({ databanks: banks }),
  addDatabank: (bank) => set((s) => ({ databanks: [...s.databanks, bank] })),
  updateDatabank: (id, updates) =>
    set((s) => ({
      databanks: s.databanks.map((b) => (b.id === id ? { ...b, ...updates } : b)),
    })),
  removeDatabank: (id) =>
    set((s) => ({
      databanks: s.databanks.filter((b) => b.id !== id),
      selectedDatabankId: s.selectedDatabankId === id ? null : s.selectedDatabankId,
    })),
  setSelectedDatabankId: (id) => set({ selectedDatabankId: id }),
  setDatabankScopeFilter: (scope) => set({ databankScopeFilter: scope }),
  setDatabankScopeCharacterId: (id) => set({ databankScopeCharacterId: id }),

  setDatabankDocuments: (docs) => set({ databankDocuments: docs }),
  addDatabankDocument: (doc) => set((s) => ({ databankDocuments: [...s.databankDocuments, doc] })),
  updateDatabankDocument: (id, updates) =>
    set((s) => ({
      databankDocuments: s.databankDocuments.map((d) => (d.id === id ? { ...d, ...updates } : d)),
    })),
  removeDatabankDocument: (id) =>
    set((s) => ({ databankDocuments: s.databankDocuments.filter((d) => d.id !== id) })),
})
