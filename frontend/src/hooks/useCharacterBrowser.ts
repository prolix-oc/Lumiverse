import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router'
import { toast } from '@/lib/toast'
import { charactersApi } from '@/api/characters'
import { chatsApi } from '@/api/chats'
import { get } from '@/api/client'
import { useStore } from '@/store'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import type { Character, CharacterSummary, TagCount } from '@/types/api'
import type { LorebookInfo } from '@/components/modals/BulkImportProgressModal'

const SEARCH_DEBOUNCE_MS = 150

export function useCharacterBrowser() {
  const navigate = useNavigate()
  const [currentPage, setCurrentPage] = useState(1)
  const charactersPerPage = useStore((s) => s.charactersPerPage)
  const setSetting = useStore((s) => s.setSetting)

  // Store state (still used for background population for other components)
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

  // Shuffle state
  const [shuffleSeed, setShuffleSeed] = useState(() => Math.floor(Date.now() / 86_400_000))

  // Local state
  const [loading, setLoading] = useState(false)
  const [importProgress, setImportProgress] = useState<{
    step: 'uploading' | 'processing' | 'gallery'
    percent: number
    filename: string
    galleryCurrent?: number
    galleryTotal?: number
  } | null>(null)
  const importLoading = !!importProgress
  const [importError, setImportError] = useState<string | null>(null)
  const [batchDeleteProgress, setBatchDeleteProgress] = useState<{ done: number; total: number } | null>(null)
  const [pendingLorebookImport, setPendingLorebookImport] = useState<Character | null>(null)
  const [bulkImportFiles, setBulkImportFiles] = useState<File[]>([])
  const [bulkImportOpen, setBulkImportOpen] = useState(false)
  const [pendingLorebooks, setPendingLorebooks] = useState<LorebookInfo[]>([])
  const [lorebookModalOpen, setLorebookModalOpen] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery)

  // Listen for gallery progress WS events during import
  useEffect(() => {
    if (!importProgress) return
    return wsClient.on(
      EventType.IMPORT_GALLERY_PROGRESS,
      (payload: { current: number; total: number; filename: string }) => {
        setImportProgress((prev) =>
          prev
            ? {
                ...prev,
                step: 'gallery',
                galleryCurrent: payload.current,
                galleryTotal: payload.total,
              }
            : null,
        )
      },
    )
  }, [!!importProgress])

  // ─── Server-side paginated summaries (the fast path) ────────────────────
  const [browserItems, setBrowserItems] = useState<CharacterSummary[]>([])
  const [browserTotal, setBrowserTotal] = useState(0)
  const [allTags, setAllTags] = useState<TagCount[]>([])

  // Debounced search
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedQuery(searchQuery), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(debounceRef.current)
  }, [searchQuery])

  // ─── Fetch current page from server ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const params: Record<string, any> = {
      limit: charactersPerPage,
      offset: (currentPage - 1) * charactersPerPage,
    }

    // Sort
    if (sortField === 'shuffle') {
      params.sort = 'discover'
      params.seed = shuffleSeed
    } else {
      params.sort = sortField
      params.direction = sortDirection
    }

    // Search
    if (debouncedQuery.trim()) {
      params.search = debouncedQuery.trim()
    }

    // Tag filter
    if (selectedTags.length > 0) {
      params.tags = selectedTags.join(',')
    }

    // Favorites filter
    if (filterTab === 'favorites' || filterTab === 'characters') {
      params.filter = filterTab === 'favorites' ? 'favorites' : 'non-favorites'
      if (favorites.length > 0) {
        params.favorite_ids = favorites.join(',')
      }
    }

    charactersApi
      .listSummaries(params)
      .then((result) => {
        if (cancelled) return
        setBrowserItems(result.data)
        setBrowserTotal(result.total)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[CharacterBrowser] Failed to load summaries:', err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [currentPage, charactersPerPage, sortField, sortDirection, shuffleSeed, debouncedQuery, selectedTags, filterTab, favorites])

  // ─── Load tags once ─────────────────────────────────────────────────────
  useEffect(() => {
    charactersApi.listTags().then(setAllTags).catch(() => {})
  }, [])

  // ─── Background: populate store with full characters (for other components) ──
  useEffect(() => {
    if (charactersLoaded) return
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
    loadAll().catch((err) => console.error('[CharacterBrowser] Background load failed:', err))
  }, [charactersLoaded, setCharacters])

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1)
  }, [filterTab, selectedTags, debouncedQuery, sortField, sortDirection, shuffleSeed])

  const totalPages = Math.max(1, Math.ceil(browserTotal / charactersPerPage))
  const safePage = Math.min(currentPage, totalPages)

  // Favorite characters (from store, for slider — uses full character data)
  const favoriteCharacters = useMemo(
    () => characters.filter((c) => favorites.includes(c.id)),
    [characters, favorites]
  )

  // Reshuffle
  const handleToggleSortDirection = useCallback(() => {
    if (sortField === 'shuffle') {
      setShuffleSeed(Date.now())
    } else {
      toggleSortDirection()
    }
  }, [sortField, toggleSortDirection])

  const setCharactersPerPage = useCallback(
    (perPage: number) => {
      setSetting('charactersPerPage', perPage)
      setCurrentPage(1)
    },
    [setSetting]
  )

  // Import file
  const importFile = useCallback(
    async (file: File) => {
      setImportProgress({ step: 'uploading', percent: 0, filename: file.name })
      setImportError(null)
      try {
        const result = await charactersApi.importFile(file, (percent) => {
          setImportProgress((prev) =>
            prev
              ? percent >= 100
                ? { ...prev, step: 'processing', percent: 100 }
                : { ...prev, percent }
              : null
          )
        })
        addCharacter(result.character)
        // Refresh browser page to show new character
        setBrowserTotal((t) => t + 1)
        if (result.character.extensions?.character_book?.entries?.length > 0) {
          setPendingLorebookImport(result.character)
        }
      } catch (err: any) {
        const msg = err?.body?.message || err?.message || 'Import failed'
        setImportError(msg)
        throw err
      } finally {
        setImportProgress(null)
      }
    },
    [addCharacter]
  )

  // Import multiple files
  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 1) {
        return importFile(files[0])
      }
      setBulkImportFiles(files)
      setBulkImportOpen(true)
    },
    [importFile]
  )

  // Called by BulkImportProgressModal when all chunks complete
  const handleBulkImportComplete = useCallback(
    (imported: Character[], lorebooks: LorebookInfo[]) => {
      if (imported.length > 0) addCharacters(imported)
      setBrowserTotal((t) => t + imported.length)
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
      setImportProgress({ step: 'processing', percent: 100, filename: url })
      setImportError(null)
      try {
        const result = await charactersApi.importUrl(url)
        addCharacter(result.character)
        setBrowserTotal((t) => t + 1)
        toast.success(`${result.character.name} was imported`)
        if (result.character.extensions?.character_book?.entries?.length > 0) {
          setPendingLorebookImport(result.character)
        }
      } catch (err: any) {
        const msg = err?.body?.message || err?.message || 'Import failed'
        setImportError(msg)
        throw err
      } finally {
        setImportProgress(null)
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
        setBrowserTotal((t) => Math.max(0, t - result.deleted.length))
      } catch {
        let done = 0
        for (const id of ids) {
          try {
            await charactersApi.delete(id)
            done++
          } catch { /* skip */ }
          setBatchDeleteProgress({ done, total: ids.length })
        }
        removeCharacters(ids)
        setBrowserTotal((t) => Math.max(0, t - ids.length))
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
      setBrowserTotal((t) => t + 1)
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
      setBrowserTotal((t) => t + 1)
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
      setBrowserTotal((t) => Math.max(0, t - 1))
    },
    [removeCharacters]
  )

  const openModal = useStore((s) => s.openModal)

  // Open chat
  const openChat = useCallback(
    async (character: Character | CharacterSummary) => {
      try {
        const chats = await get<any[]>('/chats/character-chats/' + character.id)

        if (chats.length === 1) {
          navigate(`/chat/${chats[0].id}`)
          return
        }

        if (chats.length > 1) {
          openModal('chatPicker', {
            characterId: character.id,
            characterName: character.name,
            onSelect: (chatId: string) => navigate(`/chat/${chatId}`)
          })
          return
        }

        // Check for alternate greetings — use has_alternate_greetings from summary,
        // or alternate_greetings from full character
        const hasAlternates = 'has_alternate_greetings' in character
          ? character.has_alternate_greetings
          : (character as Character).alternate_greetings?.length > 0

        if (hasAlternates) {
          // Fetch full character for greeting content
          const fullChar = await charactersApi.get(character.id)
          openModal('greetingPicker', {
            character: fullChar,
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

  // Start a new chat
  const startNewChat = useCallback(
    async (character: Character | CharacterSummary) => {
      try {
        const hasAlternates = 'has_alternate_greetings' in character
          ? character.has_alternate_greetings
          : (character as Character).alternate_greetings?.length > 0

        if (hasAlternates) {
          const fullChar = await charactersApi.get(character.id)
          openModal('greetingPicker', {
            character: fullChar,
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

  // ─── Trigger a re-fetch of the current browser page ─────────────────────
  const refreshBrowser = useCallback(() => {
    // Bump a counter or toggle to force the useEffect to re-run
    setCurrentPage((p) => p)
    // Force re-fetch by toggling loading
    setBrowserItems([])
    setBrowserTotal(0)
  }, [])

  return {
    // State — browser items come from server-side pagination
    characters: browserItems,
    allCharacters: characters,
    totalFiltered: browserTotal,
    favoriteCharacters,
    loading,
    importLoading,
    importProgress,
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
    toggleSortDirection: handleToggleSortDirection,
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
    refreshBrowser,
    clearImportError: () => setImportError(null),
    clearPendingLorebookImport: () => setPendingLorebookImport(null),
  }
}
