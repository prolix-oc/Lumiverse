import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router'
import Fuse from 'fuse.js'
import { charactersApi } from '@/api/characters'
import { chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import type { Character } from '@/types/api'
import type { LorebookInfo } from '@/components/modals/BulkImportProgressModal'

const SEARCH_DEBOUNCE_MS = 150

export function useCharacterBrowser() {
  const navigate = useNavigate()
  const [currentPage, setCurrentPage] = useState(1)
  const charactersPerPage = useStore((s) => s.charactersPerPage)
  const setSetting = useStore((s) => s.setSetting)

  // Store state
  const characters = useStore((s) => s.characters)
  const charactersLoaded = useStore((s) => s.charactersLoaded)
  const setCharacters = useStore((s) => s.setCharacters)
  const favorites = useStore((s) => s.favorites)
  const toggleFavorite = useStore((s) => s.toggleFavorite)
  const searchQuery = useStore((s) => s.searchQuery)
  const setSearchQuery = useStore((s) => s.setSearchQuery)
  const filterTab = useStore((s) => s.filterTab)
  const setFilterTab = useStore((s) => s.setFilterTab)
  const sortField = useStore((s) => s.sortField)
  const setSortField = useStore((s) => s.setSortField)
  const sortDirection = useStore((s) => s.sortDirection)
  const toggleSortDirection = useStore((s) => s.toggleSortDirection)
  const viewMode = useStore((s) => s.viewMode)
  const setViewMode = useStore((s) => s.setViewMode)
  const selectedTags = useStore((s) => s.selectedTags)
  const setSelectedTags = useStore((s) => s.setSelectedTags)
  const toggleSelectedTag = useStore((s) => s.toggleSelectedTag)
  const batchMode = useStore((s) => s.batchMode)
  const setBatchMode = useStore((s) => s.setBatchMode)
  const batchSelected = useStore((s) => s.batchSelected)
  const toggleBatchSelect = useStore((s) => s.toggleBatchSelect)
  const selectAllBatch = useStore((s) => s.selectAllBatch)
  const clearBatchSelection = useStore((s) => s.clearBatchSelection)
  const addCharacter = useStore((s) => s.addCharacter)
  const addCharacters = useStore((s) => s.addCharacters)
  const removeCharacters = useStore((s) => s.removeCharacters)
  const updateCharacterInStore = useStore((s) => s.updateCharacter)

  // Local state
  const [loading, setLoading] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [batchDeleteProgress, setBatchDeleteProgress] = useState<{ done: number; total: number } | null>(null)
  const [pendingLorebookImport, setPendingLorebookImport] = useState<Character | null>(null)
  const [bulkImportFiles, setBulkImportFiles] = useState<File[]>([])
  const [bulkImportOpen, setBulkImportOpen] = useState(false)
  const [pendingLorebooks, setPendingLorebooks] = useState<LorebookInfo[]>([])
  const [lorebookModalOpen, setLorebookModalOpen] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery)

  // Debounced search
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedQuery(searchQuery), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(debounceRef.current)
  }, [searchQuery])

  // Load all characters on mount if not yet loaded (paginate through API)
  useEffect(() => {
    if (charactersLoaded) return
    setLoading(true)
    const loadAll = async () => {
      const PAGE = 200
      let all: Character[] = []
      let offset = 0
      let total = Infinity
      while (offset < total) {
        const result = await charactersApi.list({ limit: PAGE, offset })
        all = all.concat(result.data)
        total = result.total
        offset += result.data.length
        if (result.data.length < PAGE) break
      }
      setCharacters(all)
    }
    loadAll()
      .catch((err) => console.error('[CharacterBrowser] Failed to load:', err))
      .finally(() => setLoading(false))
  }, [charactersLoaded, setCharacters])

  // Fuse.js instance
  const fuse = useMemo(
    () =>
      new Fuse(characters, {
        keys: ['name', 'creator', 'creator_notes', 'tags'],
        threshold: 0.3,
      }),
    [characters]
  )

  // Tag extraction: unique tags with counts
  const allTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const char of characters) {
      if (char.tags) {
        for (const tag of char.tags) {
          counts.set(tag, (counts.get(tag) || 0) + 1)
        }
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }))
  }, [characters])

  // Filtering pipeline
  const filteredCharacters = useMemo(() => {
    let result = characters

    // 1. Filter tab
    if (filterTab === 'favorites') {
      result = result.filter((c) => favorites.includes(c.id))
    }
    // 'characters' tab shows non-favorites; 'all' shows everything
    if (filterTab === 'characters') {
      result = result.filter((c) => !favorites.includes(c.id))
    }

    // 2. Tag filter (AND logic)
    if (selectedTags.length > 0) {
      result = result.filter((c) =>
        selectedTags.every((tag) => c.tags?.includes(tag))
      )
    }

    // 3. Search
    if (debouncedQuery.trim()) {
      const searchResults = fuse.search(debouncedQuery)
      const searchIds = new Set(searchResults.map((r) => r.item.id))
      result = result.filter((c) => searchIds.has(c.id))
    }

    // 4. Sort
    result = [...result].sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'name':
          cmp = a.name.localeCompare(b.name)
          break
        case 'recent':
          cmp = (b.updated_at || 0) - (a.updated_at || 0)
          break
        case 'created':
          cmp = (b.created_at || 0) - (a.created_at || 0)
          break
      }
      return sortDirection === 'desc' ? -cmp : cmp
    })

    return result
  }, [characters, filterTab, favorites, selectedTags, debouncedQuery, fuse, sortField, sortDirection])

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1)
  }, [filterTab, selectedTags, debouncedQuery, sortField, sortDirection])

  // Paginate filtered results
  const totalPages = Math.max(1, Math.ceil(filteredCharacters.length / charactersPerPage))
  const safePage = Math.min(currentPage, totalPages)
  const paginatedCharacters = useMemo(() => {
    const start = (safePage - 1) * charactersPerPage
    return filteredCharacters.slice(start, start + charactersPerPage)
  }, [filteredCharacters, safePage, charactersPerPage])

  const setCharactersPerPage = useCallback(
    (perPage: number) => {
      setSetting('charactersPerPage', perPage)
      setCurrentPage(1)
    },
    [setSetting]
  )

  // Favorite characters (for slider)
  const favoriteCharacters = useMemo(
    () => characters.filter((c) => favorites.includes(c.id)),
    [characters, favorites]
  )

  // Import file
  const importFile = useCallback(
    async (file: File) => {
      setImportLoading(true)
      setImportError(null)
      try {
        const result = await charactersApi.importFile(file)
        addCharacter(result.character)
        if (result.character.extensions?.character_book?.entries?.length > 0) {
          setPendingLorebookImport(result.character)
        }
      } catch (err: any) {
        const msg = err?.body?.message || err?.message || 'Import failed'
        setImportError(msg)
        throw err
      } finally {
        setImportLoading(false)
      }
    },
    [addCharacter]
  )

  // Import multiple files — single file uses legacy path, 2+ opens bulk modal
  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 1) {
        return importFile(files[0])
      }
      // Open bulk import modal
      setBulkImportFiles(files)
      setBulkImportOpen(true)
    },
    [importFile]
  )

  // Called by BulkImportProgressModal when all chunks complete
  const handleBulkImportComplete = useCallback(
    (imported: Character[], lorebooks: LorebookInfo[]) => {
      if (imported.length > 0) addCharacters(imported)
      if (lorebooks.length > 0) {
        setPendingLorebooks(lorebooks)
      }
    },
    [addCharacters]
  )

  // Called when bulk progress modal is closed
  const closeBulkImport = useCallback(() => {
    setBulkImportOpen(false)
    setBulkImportFiles([])
    // If there are pending lorebooks, show the lorebook modal after a brief delay
    if (pendingLorebooks.length > 0) {
      setLorebookModalOpen(true)
    }
  }, [pendingLorebooks])

  const closeLorebookModal = useCallback(() => {
    setLorebookModalOpen(false)
    setPendingLorebooks([])
  }, [])

  // Import URL
  const importUrl = useCallback(
    async (url: string) => {
      setImportLoading(true)
      setImportError(null)
      try {
        const result = await charactersApi.importUrl(url)
        addCharacter(result.character)
        if (result.character.extensions?.character_book?.entries?.length > 0) {
          setPendingLorebookImport(result.character)
        }
      } catch (err: any) {
        const msg = err?.body?.message || err?.message || 'Import failed'
        setImportError(msg)
        throw err
      } finally {
        setImportLoading(false)
      }
    },
    [addCharacter]
  )

  // Batch delete
  const batchDelete = useCallback(
    async (keepChats = false) => {
      const ids = [...batchSelected]
      if (ids.length === 0) return
      setBatchDeleteProgress({ done: 0, total: ids.length })
      try {
        const result = await charactersApi.batchDelete(ids, keepChats)
        removeCharacters(result.deleted)
      } catch {
        // Fallback: delete individually
        let done = 0
        for (const id of ids) {
          try {
            await charactersApi.delete(id)
            done++
          } catch { /* skip */ }
          setBatchDeleteProgress({ done, total: ids.length })
        }
        removeCharacters(ids)
      }
      setBatchMode(false)
      setBatchDeleteProgress(null)
    },
    [batchSelected, removeCharacters, setBatchMode]
  )

  // Create new character
  const createCharacter = useCallback(
    async () => {
      const character = await charactersApi.create({ name: 'New Character' })
      addCharacter(character)
      return character
    },
    [addCharacter]
  )

  // Update character
  const updateCharacter = useCallback(
    async (id: string, input: any) => {
      const character = await charactersApi.update(id, input)
      updateCharacterInStore(id, character)
      return character
    },
    [updateCharacterInStore]
  )

  // Duplicate character
  const duplicateCharacter = useCallback(
    async (id: string) => {
      const character = await charactersApi.duplicate(id)
      addCharacter(character)
      return character
    },
    [addCharacter]
  )

  // Upload avatar
  const uploadAvatar = useCallback(
    async (id: string, file: File) => {
      await charactersApi.uploadAvatar(id, file)
      const updated = await charactersApi.get(id)
      updateCharacterInStore(id, updated)
      return updated
    },
    [updateCharacterInStore]
  )

  // Delete single character
  const deleteCharacter = useCallback(
    async (id: string) => {
      await charactersApi.delete(id)
      removeCharacters([id])
    },
    [removeCharacters]
  )

  const openModal = useStore((s) => s.openModal)

  // Open chat — reuse most recent existing chat, or create a new one
  const openChat = useCallback(
    async (character: Character) => {
      try {
        const existing = await chatsApi.list({ characterId: character.id, limit: 1 })
        if (existing.data.length > 0) {
          navigate(`/chat/${existing.data[0].id}`)
          return
        }

        // If character has alternate greetings, show picker
        if (character.alternate_greetings?.length > 0) {
          openModal('greetingPicker', {
            character,
            onSelect: async (greetingIndex: number) => {
              try {
                const chat = await chatsApi.create({
                  character_id: character.id,
                  greeting_index: greetingIndex,
                })
                navigate(`/chat/${chat.id}`)
              } catch (err) {
                console.error('[CharacterBrowser] Failed to create chat:', err)
              }
            },
          })
          return
        }

        const chat = await chatsApi.create({ character_id: character.id })
        navigate(`/chat/${chat.id}`)
      } catch (err) {
        console.error('[CharacterBrowser] Failed to open chat:', err)
      }
    },
    [navigate, openModal]
  )

  // Start a new chat — always creates, skips existing-chat check
  const startNewChat = useCallback(
    async (character: Character) => {
      try {
        if (character.alternate_greetings?.length > 0) {
          openModal('greetingPicker', {
            character,
            onSelect: async (greetingIndex: number) => {
              try {
                const chat = await chatsApi.create({
                  character_id: character.id,
                  greeting_index: greetingIndex,
                })
                navigate(`/chat/${chat.id}`)
              } catch (err) {
                console.error('[CharacterBrowser] Failed to create chat:', err)
              }
            },
          })
          return
        }

        const chat = await chatsApi.create({ character_id: character.id })
        navigate(`/chat/${chat.id}`)
      } catch (err) {
        console.error('[CharacterBrowser] Failed to start new chat:', err)
      }
    },
    [navigate, openModal]
  )

  return {
    // State
    characters: paginatedCharacters,
    allCharacters: characters,
    totalFiltered: filteredCharacters.length,
    favoriteCharacters,
    loading,
    importLoading,
    importError,
    batchDeleteProgress,
    pendingLorebookImport,
    bulkImportFiles,
    bulkImportOpen,
    pendingLorebooks,
    lorebookModalOpen,
    searchQuery,
    filterTab,
    sortField,
    sortDirection,
    viewMode,
    selectedTags,
    allTags,
    batchMode,
    batchSelected,
    favorites,
    currentPage: safePage,
    totalPages,
    charactersPerPage,

    // Actions
    setCurrentPage,
    setCharactersPerPage,
    setSearchQuery,
    setFilterTab,
    setSortField,
    toggleSortDirection,
    setViewMode,
    setSelectedTags,
    toggleSelectedTag,
    toggleFavorite,
    setBatchMode,
    toggleBatchSelect,
    selectAllBatch,
    clearBatchSelection,
    createCharacter,
    updateCharacter,
    duplicateCharacter,
    uploadAvatar,
    deleteCharacter,
    importFile,
    importFiles,
    importUrl,
    handleBulkImportComplete,
    closeBulkImport,
    closeLorebookModal,
    batchDelete,
    openChat,
    startNewChat,
    clearImportError: () => setImportError(null),
    clearPendingLorebookImport: () => setPendingLorebookImport(null),
  }
}
