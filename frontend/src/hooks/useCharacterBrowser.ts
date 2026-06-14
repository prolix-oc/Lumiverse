import { useState, useEffect, useCallback, useRef } from 'react'
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
import type { ExpressionsImportInfo } from '@/components/modals/ExpressionsImportModal'
import type { AlternateFieldsSummaryInfo } from '@/components/modals/AlternateFieldsSummaryModal'
import { getEmbeddedCharacterBookEntryCount } from '@/utils/character-world-books'
import i18n from '@/i18n'

/**
 * If a character carries a portable LoRA hint in `extensions.lumiverse_image_gen_lora`,
 * surface it as a non-blocking toast so the user knows the original creator
 * expects a specific LoRA. Never auto-fetches the source URL — Lumiverse
 * displays only.
 */
function maybeShowImportedLoraHint(character: Character): void {
  const raw = (character.extensions as any)?.lumiverse_image_gen_lora
  if (!raw || typeof raw !== 'object') return
  if (typeof raw.lora_filename !== 'string' || !raw.lora_filename) return
  if (typeof raw.weight !== 'number' || !Number.isFinite(raw.weight)) return
  const sourceHint = typeof raw.source_url === 'string' && raw.source_url
    ? i18n.t('panels.characterBrowser.toast.loraSourceHint')
    : ''
  toast.info(
    i18n.t('panels.characterBrowser.toast.loraHint', {
      name: character.name,
      filename: raw.lora_filename,
      weight: raw.weight,
      sourceHint,
    }),
    { duration: 8000 },
  )
}

const SEARCH_DEBOUNCE_MS = 150

export function useCharacterBrowser() {
  const navigate = useNavigate()
  const [currentPage, setCurrentPage] = useState(1)
  const settingsLoaded = useStore((s) => s.settingsLoaded)
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
  const excludedTags = useStore((s) => s.excludedTags)
  const cycleTagFilter = useStore((s) => s.cycleTagFilter)
  const clearTagFilters = useStore((s) => s.clearTagFilters)
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

  // Fetch version — bumped to force a re-fetch of server-paginated browser items
  const [fetchVersion, setFetchVersion] = useState(0)

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
  const [pendingExpressions, setPendingExpressions] = useState<ExpressionsImportInfo[]>([])
  const [expressionsModalOpen, setExpressionsModalOpen] = useState(false)
  const [pendingAltFieldsSummary, setPendingAltFieldsSummary] = useState<AlternateFieldsSummaryInfo[]>([])
  const [altFieldsSummaryOpen, setAltFieldsSummaryOpen] = useState(false)
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

  // Refresh gallery when LumiHub install completes (external mutation)
  useEffect(() => {
    return wsClient.on(EventType.LUMIHUB_INSTALL_COMPLETED, () => {
      setFetchVersion((v) => v + 1)
    })
  }, [])

  useEffect(() => {
    const refresh = () => {
      setFetchVersion((v) => v + 1)
    }
    const offCreated = wsClient.on(EventType.CHARACTER_CREATED, refresh)
    const offEdited = wsClient.on(EventType.CHARACTER_EDITED, refresh)
    const offDeleted = wsClient.on(EventType.CHARACTER_DELETED, refresh)
    return () => {
      offCreated()
      offEdited()
      offDeleted()
    }
  }, [])

  // ─── Server-side paginated summaries (the fast path) ────────────────────
  const [browserItems, setBrowserItems] = useState<CharacterSummary[]>([])
  const [browserTotal, setBrowserTotal] = useState(0)
  const [allTags, setAllTags] = useState<TagCount[]>([])
  const [favoriteCharacters, setFavoriteCharacters] = useState<CharacterSummary[]>([])
  const favoriteMutationSeqRef = useRef(0)
  const favoritesRef = useRef(favorites)

  // Debounced search
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedQuery(searchQuery), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(debounceRef.current)
  }, [searchQuery])

  useEffect(() => {
    favoritesRef.current = favorites
  }, [favorites])

  const buildSummaryParams = useCallback(
    (options?: {
      page?: number
      favoritesOverride?: string[]
      limit?: number
      offset?: number
    }) => {
      const activeFavorites = options?.favoritesOverride ?? favoritesRef.current
      const limit = options?.limit ?? charactersPerPage
      const offset = options?.offset ?? ((options?.page ?? currentPage) - 1) * charactersPerPage
      const params: Record<string, any> = { limit, offset }

      if (sortField === 'shuffle') {
        params.sort = 'discover'
        params.seed = shuffleSeed
      } else {
        params.sort = sortField
        params.direction = sortDirection
      }

      if (debouncedQuery.trim()) {
        params.search = debouncedQuery.trim()
      }

      if (selectedTags.length > 0) {
        params.tags = selectedTags.join(',')
      }

      if (excludedTags.length > 0) {
        params.exclude_tags = excludedTags.join(',')
      }

      if (filterTab === 'favorites' || filterTab === 'characters') {
        params.filter = filterTab === 'favorites' ? 'favorites' : 'non-favorites'
        if (activeFavorites.length > 0) {
          params.favorite_ids = activeFavorites.join(',')
        }
      }

      return params
    },
    [charactersPerPage, currentPage, sortField, sortDirection, shuffleSeed, debouncedQuery, selectedTags, excludedTags, filterTab]
  )

  const loadAllCharacters = useCallback(async () => {
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
  }, [setCharacters])

  // ─── Fetch current page from server ─────────────────────────────────────
  useEffect(() => {
    if (!settingsLoaded) return

    let cancelled = false
    favoriteMutationSeqRef.current += 1
    setLoading(true)

    charactersApi
      .listSummaries(buildSummaryParams())
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
  }, [buildSummaryParams, fetchVersion, settingsLoaded])

  // ─── Load tags once ─────────────────────────────────────────────────────
  useEffect(() => {
    charactersApi.listTags().then(setAllTags).catch(() => {})
  }, [fetchVersion])

  // ─── Background: populate store with full characters (for other components) ──
  useEffect(() => {
    if (charactersLoaded) return
    loadAllCharacters().catch((err) => console.error('[CharacterBrowser] Background load failed:', err))
  }, [charactersLoaded, loadAllCharacters])

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1)
  }, [filterTab, selectedTags, excludedTags, debouncedQuery, sortField, sortDirection, shuffleSeed])

  const totalPages = Math.max(1, Math.ceil(browserTotal / charactersPerPage))
  const safePage = Math.min(currentPage, totalPages)

  // Favorite slider: fetch summaries directly so it doesn't wait for the
  // background full-character crawl to complete.
  useEffect(() => {
    if (!settingsLoaded) return
    if (favorites.length === 0) {
      setFavoriteCharacters([])
      return
    }

    let cancelled = false
    charactersApi
      .listSummaries({
        limit: favorites.length,
        offset: 0,
        sort: 'recent',
        direction: 'desc',
        filter: 'favorites',
        favorite_ids: favorites.join(','),
      })
      .then((result) => {
        if (!cancelled) setFavoriteCharacters(result.data)
      })
      .catch((err) => {
        if (!cancelled) console.error('[CharacterBrowser] Failed to load favorite summaries:', err)
      })

    return () => { cancelled = true }
  }, [favorites, settingsLoaded, fetchVersion])

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
        setBrowserTotal((t) => t + 1)
        setFetchVersion((v) => v + 1)
        if (getEmbeddedCharacterBookEntryCount(result.character.extensions) > 0
            && !(result.character.extensions?.world_book_ids?.length > 0)) {
          setPendingLorebookImport(result.character)
        }
        maybeShowImportedLoraHint(result.character)
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
      setFetchVersion((v) => v + 1)
      // Only show lorebook modal for books that weren't auto-imported by the backend
      const importedMap = new Map(imported.map((c) => [c.id, c]))
      const unlinked = lorebooks.filter((l) => {
        const char = importedMap.get(l.characterId)
        return char && !(char.extensions?.world_book_ids?.length > 0)
      })
      if (unlinked.length > 0) {
        setPendingLorebooks(unlinked)
      }
      for (const c of imported) maybeShowImportedLoraHint(c)
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
    // Chain to expressions modal if pending
    if (pendingExpressions.length > 0) {
      setExpressionsModalOpen(true)
    } else if (pendingAltFieldsSummary.length > 0) {
      setAltFieldsSummaryOpen(true)
    }
  }, [pendingExpressions, pendingAltFieldsSummary])

  const closeExpressionsModal = useCallback(() => {
    setExpressionsModalOpen(false)
    setPendingExpressions([])
    // Chain to alternate fields summary if pending
    if (pendingAltFieldsSummary.length > 0) {
      setAltFieldsSummaryOpen(true)
    }
  }, [pendingAltFieldsSummary])

  const closeAltFieldsSummary = useCallback(() => {
    setAltFieldsSummaryOpen(false)
    setPendingAltFieldsSummary([])
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
        setFetchVersion((v) => v + 1)
        toast.success(i18n.t('chat.toast.characterImported', { name: result.character.name }))
        if (getEmbeddedCharacterBookEntryCount(result.character.extensions) > 0
            && !(result.character.extensions?.world_book_ids?.length > 0)) {
          setPendingLorebookImport(result.character)
        }
        maybeShowImportedLoraHint(result.character)
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
      setFetchVersion((v) => v + 1)
    },
    [batchSelected, removeCharacters, setBatchMode]
  )

  // Create new character
  const createCharacter = useCallback(
    async () => {
      const character = await charactersApi.create({ name: 'New Character' })
      addCharacter(character)
      setBrowserTotal((t) => t + 1)
      setFetchVersion((v) => v + 1)
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
      setFetchVersion((v) => v + 1)
      return character
    },
    [addCharacter]
  )

  // Upload avatar
  const uploadAvatar = useCallback(
    async (id: string, file: File) => {
      const updated = await charactersApi.uploadAvatar(id, file)
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
      setFetchVersion((v) => v + 1)
    },
    [removeCharacters]
  )

  const openModal = useStore((s) => s.openModal)
  const showChatCreationToast = useCallback(
    () => toast.info(i18n.t('chat.toast.creatingChatCortex'), {
      title: i18n.t('chat.toast.startingChat'),
      duration: 60_000,
      dismissible: false,
    }),
    []
  )

  // Open chat
  const openChat = useCallback(
    async (character: Character | CharacterSummary) => {
      let creationToastId: string | null = null
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
              const toastId = showChatCreationToast()
              try {
                const chat = await chatsApi.create({
                  character_id: character.id,
                  greeting_index: greetingIndex,
                })
                toast.dismiss(toastId)
                navigate(`/chat/${chat.id}`)
              } catch (err) {
                toast.dismiss(toastId)
                console.error('[CharacterBrowser] Failed to create chat:', err)
                toast.error(i18n.t('chat.toast.failedCreateChat'))
              }
            },
          })
          return
        }

        creationToastId = showChatCreationToast()
        const chat = await chatsApi.create({ character_id: character.id })
        toast.dismiss(creationToastId)
        creationToastId = null
        navigate(`/chat/${chat.id}`)
      } catch (err) {
        if (creationToastId) toast.dismiss(creationToastId)
        console.error('[CharacterBrowser] Failed to open chat:', err)
        toast.error(i18n.t('chat.toast.failedOpenChat'))
      }
    },
    [navigate, openModal, showChatCreationToast]
  )

  // Start a new chat
  const startNewChat = useCallback(
    async (character: Character | CharacterSummary) => {
      let creationToastId: string | null = null
      try {
        const hasAlternates = 'has_alternate_greetings' in character
          ? character.has_alternate_greetings
          : (character as Character).alternate_greetings?.length > 0

        if (hasAlternates) {
          const fullChar = await charactersApi.get(character.id)
          openModal('greetingPicker', {
            character: fullChar,
            onSelect: async (greetingIndex: number) => {
              const toastId = showChatCreationToast()
              try {
                const chat = await chatsApi.create({
                  character_id: character.id,
                  greeting_index: greetingIndex,
                })
                toast.dismiss(toastId)
                navigate(`/chat/${chat.id}`)
              } catch (err) {
                toast.dismiss(toastId)
                console.error('[CharacterBrowser] Failed to create chat:', err)
                toast.error(i18n.t('chat.toast.failedCreateChat'))
              }
            },
          })
          return
        }

        creationToastId = showChatCreationToast()
        const chat = await chatsApi.create({ character_id: character.id })
        toast.dismiss(creationToastId)
        creationToastId = null
        navigate(`/chat/${chat.id}`)
      } catch (err) {
        if (creationToastId) toast.dismiss(creationToastId)
        console.error('[CharacterBrowser] Failed to start new chat:', err)
        toast.error(i18n.t('chat.toast.failedStartNewChat'))
      }
    },
    [navigate, openModal, showChatCreationToast]
  )

  // ─── Trigger a re-fetch of the current browser page ─────────────────────
  const refreshBrowser = useCallback(() => {
    setFetchVersion((v) => v + 1)
  }, [])

  const reloadAllCharacters = useCallback(async () => {
    await loadAllCharacters()
    setFetchVersion((v) => v + 1)
  }, [loadAllCharacters])

  const handleToggleFavorite = useCallback(
    (id: string) => {
      const wasFavorite = favorites.includes(id)
      const nextFavorites = wasFavorite
        ? favorites.filter((favoriteId) => favoriteId !== id)
        : [...favorites, id].slice(0, 15)
      const requestSeq = ++favoriteMutationSeqRef.current

      toggleFavorite(id)

      if (filterTab !== 'favorites' && filterTab !== 'characters') {
        return
      }

      const shouldRemoveFromCurrentView =
        (filterTab === 'favorites' && wasFavorite)
        || (filterTab === 'characters' && !wasFavorite)

      if (!shouldRemoveFromCurrentView) {
        return
      }

      const nextTotal = Math.max(0, browserTotal - 1)
      const nextTotalPages = Math.max(1, Math.ceil(nextTotal / charactersPerPage))
      const nextItemsLength = Math.max(0, browserItems.length - 1)
      const pageStart = (currentPage - 1) * charactersPerPage

      setBrowserItems((items) => items.filter((item) => item.id !== id))
      setBrowserTotal(nextTotal)

      if (currentPage > nextTotalPages) {
        setCurrentPage(nextTotalPages)
        return
      }

      if (nextItemsLength >= charactersPerPage || nextTotal <= pageStart + nextItemsLength) {
        return
      }

      const backfillOffset = pageStart + nextItemsLength

      charactersApi
        .listSummaries(buildSummaryParams({
          favoritesOverride: nextFavorites,
          limit: 1,
          offset: backfillOffset,
        }))
        .then((result) => {
          if (favoriteMutationSeqRef.current !== requestSeq || result.data.length === 0) return
          const [replacement] = result.data
          setBrowserItems((items) => {
            if (items.some((item) => item.id === replacement.id) || items.length >= charactersPerPage) {
              return items
            }
            return [...items, replacement]
          })
        })
        .catch((err) => {
          console.error('[CharacterBrowser] Failed to backfill summaries:', err)
        })
    },
    [favorites, toggleFavorite, filterTab, browserTotal, browserItems.length, charactersPerPage, currentPage, buildSummaryParams]
  )

  return {
    // State — browser items come from server-side pagination
    characters: browserItems,
    allCharacters: characters,
    totalFiltered: browserTotal,
    favoriteCharacters,
    loading: loading || !settingsLoaded,
    importLoading,
    importProgress,
    importError,
    batchDeleteProgress,
    pendingLorebookImport,
    bulkImportFiles,
    bulkImportOpen,
    pendingLorebooks,
    lorebookModalOpen,
    pendingExpressions,
    expressionsModalOpen,
    pendingAltFieldsSummary,
    altFieldsSummaryOpen,
    searchQuery,
    filterTab,
    sortField,
    sortDirection,
    viewMode,
    selectedTags,
    excludedTags,
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
    cycleTagFilter,
    clearTagFilters,
    toggleFavorite: handleToggleFavorite,
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
    closeExpressionsModal,
    closeAltFieldsSummary,
    batchDelete,
    openChat,
    startNewChat,
    refreshBrowser,
    reloadAllCharacters,
    clearImportError: () => setImportError(null),
    clearPendingLorebookImport: () => setPendingLorebookImport(null),
  }
}
