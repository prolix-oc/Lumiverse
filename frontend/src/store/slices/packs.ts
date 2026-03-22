import type { StateCreator } from 'zustand'
import type { PacksSlice } from '@/types/store'
import type { Pack, PackWithItems, LumiaItem, LoomItem } from '@/types/api'
import { settingsApi } from '@/api/settings'

export const createPacksSlice: StateCreator<PacksSlice> = (set) => ({
  packs: [],
  selectedPackId: null,
  packSearchQuery: '',
  packFilterTab: 'all',
  packSortField: 'updated',
  selectedDefinition: null,
  selectedBehaviors: [],
  selectedPersonalities: [],
  selectedLoomStyles: [],
  selectedLoomUtils: [],
  selectedLoomRetrofits: [],
  packsWithItems: {},

  setPacks: (packs: Pack[]) => set({ packs }),
  addPack: (pack: Pack) => set((s) => ({ packs: [pack, ...s.packs] })),
  updatePackInStore: (id: string, pack: Pack) =>
    set((s) => ({ packs: s.packs.map((p) => (p.id === id ? pack : p)) })),
  removePack: (id: string) => set((s) => ({ packs: s.packs.filter((p) => p.id !== id) })),
  setSelectedPackId: (id: string | null) => set({ selectedPackId: id }),
  setPackSearchQuery: (query: string) => set({ packSearchQuery: query }),
  setPackFilterTab: (tab) => {
    set({ packFilterTab: tab })
    settingsApi.put('packFilterTab', tab).catch(() => {})
  },
  setPackSortField: (field) => {
    set({ packSortField: field })
    settingsApi.put('packSortField', field).catch(() => {})
  },
  setSelectedDefinition: (def: LumiaItem | null) => {
    set({ selectedDefinition: def })
    settingsApi.put('selectedDefinition', def).catch(() => {})
  },
  setSelectedBehaviors: (behaviors: LumiaItem[]) => {
    set({ selectedBehaviors: behaviors })
    settingsApi.put('selectedBehaviors', behaviors).catch(() => {})
  },
  setSelectedPersonalities: (personalities: LumiaItem[]) => {
    set({ selectedPersonalities: personalities })
    settingsApi.put('selectedPersonalities', personalities).catch(() => {})
  },
  setSelectedLoomStyles: (items: LoomItem[]) => {
    set({ selectedLoomStyles: items })
    settingsApi.put('selectedLoomStyles', items).catch(() => {})
  },
  setSelectedLoomUtils: (items: LoomItem[]) => {
    set({ selectedLoomUtils: items })
    settingsApi.put('selectedLoomUtils', items).catch(() => {})
  },
  setSelectedLoomRetrofits: (items: LoomItem[]) => {
    set({ selectedLoomRetrofits: items })
    settingsApi.put('selectedLoomRetrofits', items).catch(() => {})
  },
  setPackWithItems: (id: string, data: PackWithItems) =>
    set((s) => ({ packsWithItems: { ...s.packsWithItems, [id]: data } })),
  removePackWithItems: (id: string) =>
    set((s) => {
      const { [id]: _, ...rest } = s.packsWithItems
      return { packsWithItems: rest }
    }),
})
