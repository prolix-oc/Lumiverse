import type { StateCreator } from 'zustand'
import type { CharactersSlice } from '@/types/store'
import { settingsApi } from '@/api/settings'
import type { Character, CharacterIndexItem } from '@/types/api'

function indexMutation(state: CharactersSlice, updates: CharacterIndexItem[] = [], removed: string[] = []) {
  const index = new Map(state.characterIndex.map(item => [item.id, item]))
  const revision = state.characterIndexRevision + 1
  const changes = { ...state.characterIndexChanges }
  for (const id of removed) { index.delete(id); changes[id] = revision }
  for (const item of updates) {
    const { id, name, avatar_path, image_id, creator, folder, library_scope, tags, created_at, updated_at } = item
    const avatar_crop_image_id = (item as Character).extensions?.avatar_crop_image_id ?? item.avatar_crop_image_id ?? null
    index.set(id, { id, name, avatar_path, image_id, creator, folder, library_scope, tags, created_at, updated_at, avatar_crop_image_id })
    changes[id] = revision
  }
  return { characterIndex: [...index.values()], characterIndexRevision: revision, characterIndexChanges: changes }
}

export const createCharactersSlice: StateCreator<CharactersSlice> = (set, get) => ({
  characterIndex: [],
  characterIndexLoaded: false,
  characterIndexRevision: 0,
  characterIndexGeneration: 0,
  invalidateCharacterIndex: () => set(state => ({ characterIndexLoaded: false, characterIndexGeneration: state.characterIndexGeneration + 1 })),
  characterIndexChanges: {},
  setCharacterIndex: (items, startedAtRevision) => set(state => {
    const current = new Map(state.characterIndex.map(item => [item.id, item]))
    const next = new Map(items.filter(item => (state.characterIndexChanges[item.id] ?? 0) <= startedAtRevision).map(item => [item.id, item]))
    for (const [id, revision] of Object.entries(state.characterIndexChanges)) {
      if (revision > startedAtRevision && current.has(id)) next.set(id, current.get(id)!)
    }
    return { characterIndex: [...next.values()], characterIndexLoaded: true }
  }),
  characters: [],
  charactersLoaded: false,
  favorites: [],
  activeCharacterId: null,
  selectedCharacterId: null,
  editingCharacterId: null,
  searchQuery: '',
  filterTab: 'characters',
  sortField: 'name',
  sortDirection: 'asc',
  viewMode: typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches ? 'single' : 'grid',
  selectedTags: [],
  excludedTags: [],
  batchMode: false,
  batchSelected: [],

  setCharacters: (characters) => set(state => ({ characters, charactersLoaded: true, ...indexMutation(state, characters) })),

  setCharactersLoaded: (loaded) => set({ charactersLoaded: loaded }),

  setActiveCharacter: (id) => set({ activeCharacterId: id }),

  setSelectedCharacterId: (id) => set({ selectedCharacterId: id }),

  setEditingCharacterId: (id) => set({ editingCharacterId: id }),

  updateCharacter: (id, character) => {
    // Chat open re-applies the active character on every visit. An unchanged
    // snapshot must not churn the array identity: every mounted message card
    // derives charName/risuAssetMap from `characters`, so a no-op update
    // re-renders the whole list. updated_at (epoch seconds) alone can't
    // distinguish rapid successive edits, so it only gates the deep compare.
    const existing = get().characters.find((c) => c.id === id)
    if (
      existing &&
      (existing === character ||
        (existing.updated_at === character.updated_at &&
          JSON.stringify(existing) === JSON.stringify(character)))
    ) {
      return
    }

    set((state) => {
      const existingIndex = state.characters.findIndex((c) => c.id === id)
      if (existingIndex === -1) {
        return { characters: [character, ...state.characters], ...indexMutation(state, [character]) }
      }

      const characters = [...state.characters]
      characters[existingIndex] = character
      return { characters, ...indexMutation(state, [character]) }
    })
  },

  toggleFavorite: (id) =>
    set((state) => {
      const isFav = state.favorites.includes(id)
      const favorites = isFav
        ? state.favorites.filter((f) => f !== id)
        : [...state.favorites, id]
      settingsApi.put('favorites', favorites).catch(() => {})
      return { favorites }
    }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  addCharacter: (character) =>
    set((state) => ({ characters: [character, ...state.characters], ...indexMutation(state, [character]) })),

  addCharacters: (characters) =>
    set((state) => {
      const ids = new Set(characters.map(character => character.id))
      return { characters: [...characters, ...state.characters.filter(character => !ids.has(character.id))], ...indexMutation(state, characters) }
    }),

  removeCharacter: (id) =>
    set((state) => ({
      characters: state.characters.filter((c) => c.id !== id),
      ...indexMutation(state, [], [id]),
      favorites: state.favorites.filter((f) => f !== id),
      batchSelected: state.batchSelected.filter((s) => s !== id),
    })),

  removeCharacters: (ids) =>
    set((state) => {
      const idSet = new Set(ids)
      return {
        characters: state.characters.filter((c) => !idSet.has(c.id)),
        ...indexMutation(state, [], ids),
        favorites: state.favorites.filter((f) => !idSet.has(f)),
        batchSelected: state.batchSelected.filter((s) => !idSet.has(s)),
      }
    }),

  setFilterTab: (tab) => {
    set({ filterTab: tab })
    settingsApi.put('filterTab', tab).catch(() => {})
  },

  setSortField: (field) => {
    const sortDirection = field === 'most_chats' ? 'desc' : get().sortDirection
    set({ sortField: field, sortDirection })
    settingsApi.put('sortField', field).catch(() => {})
    if (field === 'most_chats') settingsApi.put('sortDirection', sortDirection).catch(() => {})
  },

  toggleSortDirection: () =>
    set((state) => {
      const sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc'
      settingsApi.put('sortDirection', sortDirection).catch(() => {})
      return { sortDirection }
    }),

  setViewMode: (mode) => {
    // Migrate deprecated 'columns' mode from stored settings
    const resolved = mode === ('columns' as string)
      ? (window.matchMedia('(max-width: 767px)').matches ? 'single' : 'grid')
      : mode
    set({ viewMode: resolved })
    settingsApi.put('viewMode', resolved).catch(() => {})
  },

  setSelectedTags: (tags) => set({ selectedTags: tags }),

  toggleSelectedTag: (tag) =>
    set((state) => ({
      selectedTags: state.selectedTags.includes(tag)
        ? state.selectedTags.filter((t) => t !== tag)
        : [...state.selectedTags, tag],
    })),

  setExcludedTags: (tags) => set({ excludedTags: tags }),

  // Tri-state cycle: a tag is either neutral, included, or excluded — never both.
  // Clicking advances neutral → include → exclude → neutral.
  cycleTagFilter: (tag) =>
    set((state) => {
      if (state.selectedTags.includes(tag)) {
        // include → exclude
        return {
          selectedTags: state.selectedTags.filter((t) => t !== tag),
          excludedTags: [...state.excludedTags, tag],
        }
      }
      if (state.excludedTags.includes(tag)) {
        // exclude → neutral
        return { excludedTags: state.excludedTags.filter((t) => t !== tag) }
      }
      // neutral → include
      return { selectedTags: [...state.selectedTags, tag] }
    }),

  clearTagFilters: () => set({ selectedTags: [], excludedTags: [] }),

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
