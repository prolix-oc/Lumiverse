import type { StateCreator } from 'zustand'
import type { CharactersSlice } from '@/types/store'
import { settingsApi } from '@/api/settings'

export const createCharactersSlice: StateCreator<CharactersSlice> = (set) => ({
  characters: [],
  charactersLoaded: false,
  favorites: [],
  activeCharacterId: null,
  selectedCharacterId: null,
  editingCharacterId: null,
  searchQuery: '',
  filterTab: 'all',
  sortField: 'name',
  sortDirection: 'asc',
  viewMode: 'grid',
  selectedTags: [],
  batchMode: false,
  batchSelected: [],

  setCharacters: (characters) => set({ characters, charactersLoaded: true }),

  setCharactersLoaded: (loaded) => set({ charactersLoaded: loaded }),

  setActiveCharacter: (id) => set({ activeCharacterId: id }),

  setSelectedCharacterId: (id) => set({ selectedCharacterId: id }),

  setEditingCharacterId: (id) => set({ editingCharacterId: id }),

  updateCharacter: (id, character) =>
    set((state) => ({ characters: state.characters.map((c) => (c.id === id ? character : c)) })),

  toggleFavorite: (id) =>
    set((state) => {
      const isFav = state.favorites.includes(id)
      const favorites = isFav
        ? state.favorites.filter((f) => f !== id)
        : [...state.favorites, id].slice(0, 15)
      settingsApi.put('favorites', favorites).catch(() => {})
      return { favorites }
    }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  addCharacter: (character) =>
    set((state) => ({ characters: [character, ...state.characters] })),

  addCharacters: (characters) =>
    set((state) => ({ characters: [...characters, ...state.characters] })),

  removeCharacter: (id) =>
    set((state) => ({
      characters: state.characters.filter((c) => c.id !== id),
      favorites: state.favorites.filter((f) => f !== id),
      batchSelected: state.batchSelected.filter((s) => s !== id),
    })),

  removeCharacters: (ids) =>
    set((state) => {
      const idSet = new Set(ids)
      return {
        characters: state.characters.filter((c) => !idSet.has(c.id)),
        favorites: state.favorites.filter((f) => !idSet.has(f)),
        batchSelected: state.batchSelected.filter((s) => !idSet.has(s)),
      }
    }),

  setFilterTab: (tab) => {
    set({ filterTab: tab })
    settingsApi.put('filterTab', tab).catch(() => {})
  },

  setSortField: (field) => {
    set({ sortField: field })
    settingsApi.put('sortField', field).catch(() => {})
  },

  toggleSortDirection: () =>
    set((state) => {
      const sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc'
      settingsApi.put('sortDirection', sortDirection).catch(() => {})
      return { sortDirection }
    }),

  setViewMode: (mode) => {
    set({ viewMode: mode })
    settingsApi.put('viewMode', mode).catch(() => {})
  },

  setSelectedTags: (tags) => set({ selectedTags: tags }),

  toggleSelectedTag: (tag) =>
    set((state) => ({
      selectedTags: state.selectedTags.includes(tag)
        ? state.selectedTags.filter((t) => t !== tag)
        : [...state.selectedTags, tag],
    })),

  setBatchMode: (enabled) =>
    set({ batchMode: enabled, batchSelected: enabled ? [] : [] }),

  toggleBatchSelect: (id) =>
    set((state) => ({
      batchSelected: state.batchSelected.includes(id)
        ? state.batchSelected.filter((s) => s !== id)
        : [...state.batchSelected, id],
    })),

  selectAllBatch: (ids) => set({ batchSelected: ids }),

  clearBatchSelection: () => set({ batchSelected: [] }),
})
