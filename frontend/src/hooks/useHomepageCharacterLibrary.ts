import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { charactersApi } from '@/api/characters'
import { chatsApi } from '@/api/chats'
import type { CharacterPreview, CharacterSummary, TagCount } from '@/types/api'
import type {
  CharacterSortDirection,
  CharacterSortField,
  HomepageCharacterLibrarySettings,
} from '@/types/store'
import { useStore } from '@/store'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import { resolveCharacterDisplaySettings } from '@/lib/characterDisplaySettings'
import {
  applyCharacterPage,
  characterQueryKey,
  createCharacterPageState,
  exhaustedCharacterPageState,
  nextPageOffset,
  shouldLoadMore,
  HOMEPAGE_CHARACTER_PAGE_SIZE,
} from '@/lib/homepageCharacterPaging'
import type { CharacterPageState } from '@/lib/homepageCharacterPaging'
import type { SummaryParams } from '@/api/characters'

export type HomepageCharacterFilter = 'all' | 'this-chat' | 'favorites' | 'shared'

export const HOMEPAGE_PANEL_WIDTH_MIN = 360
export const HOMEPAGE_PANEL_WIDTH_MAX = 720
export const HOMEPAGE_PANEL_IMAGE_HEIGHT_MIN = 180
export const HOMEPAGE_PANEL_IMAGE_HEIGHT_MAX = 560
export const HOMEPAGE_PANEL_IMAGE_HEIGHT_DEFAULT = 320

/** Typing fires an HTTP request per keystroke without this. */
export const HOMEPAGE_SEARCH_DEBOUNCE_MS = 250

export function clampHomepagePanelWidth(value: number): number {
  return Math.min(HOMEPAGE_PANEL_WIDTH_MAX, Math.max(HOMEPAGE_PANEL_WIDTH_MIN, Math.round(value)))
}

export function clampHomepagePanelImageHeight(value: number): number {
  return Math.min(
    HOMEPAGE_PANEL_IMAGE_HEIGHT_MAX,
    Math.max(HOMEPAGE_PANEL_IMAGE_HEIGHT_MIN, Math.round(value)),
  )
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function useHomepageCharacterLibrary() {
  const settings = useStore((s) => s.homepageCharacterLibrarySettings)
  const tabSettings = useStore((s) => s.characterTabDisplaySettings)
  const favorites = useStore((s) => s.favorites)
  const activeChatId = useStore((s) => s.activeChatId)
  const setSetting = useStore((s) => s.setSetting)
  const setEditingCharacterId = useStore((s) => s.setEditingCharacterId)
  const updateCharacter = useStore((s) => s.updateCharacter)
  const openSettingsModal = useStore((s) => s.openSettings)
  const navigate = useNavigate()
  const [filter, setFilter] = useState<HomepageCharacterFilter>('all')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selectedTag, setSelectedTag] = useState('')
  const [sortField, setSortField] = useState<CharacterSortField>(settings.defaultSort)
  const [sortDirection, setSortDirection] = useState<CharacterSortDirection>('desc')
  const [characters, setCharacters] = useState<CharacterSummary[]>([])
  const [tags, setTags] = useState<TagCount[]>([])
  const [preview, setPreview] = useState<CharacterPreview | null>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryVersion, setRetryVersion] = useState(0)
  const [openingCharacterId, setOpeningCharacterId] = useState<string | null>(null)
  const openingCharacterIdRef = useRef<string | null>(null)

  // Infinite scroll bookkeeping. All of it lives in refs so that `loadMore` can stay a
  // `useCallback(..., [])` — the sentinel effect re-subscribes on every identity change,
  // and the memoised card grid downstream depends on the hook's callbacks being stable.
  //
  // `pageStateRef` carries the generation counter that makes a slow response harmless: a
  // page-1 request issued before the user retyped resolves against a state whose
  // generation has already moved on, and `applyCharacterPage` returns it unchanged.
  const pageStateRef = useRef<CharacterPageState<CharacterSummary>>(createCharacterPageState())
  const queryKeyRef = useRef<string | null>(null)
  const editRequestIdRef = useRef(0)
  /** The last key whose first page actually committed. Only this one may skip a fetch. */
  const settledQueryKeyRef = useRef<string | null>(null)
  const queryParamsRef = useRef<SummaryParams>({})
  const loadingRef = useRef(false)
  const loadingMoreRef = useRef(false)

  const commitPageState = useCallback((next: CharacterPageState<CharacterSummary>) => {
    pageStateRef.current = next
    setCharacters(next.characters as CharacterSummary[])
    setExhausted(next.exhausted)
  }, [])

  // Every setter below used to close over `settings`, so each one changed identity on
  // every store write — which defeats memoising the grid, the 900-option tag list, or
  // anything else downstream. Reading the latest settings from a ref keeps them stable.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const previewRef = useRef(preview)
  previewRef.current = preview

  const updateSettings = useCallback((patch: Partial<HomepageCharacterLibrarySettings>) => {
    setSetting('homepageCharacterLibrarySettings', { ...settingsRef.current, ...patch })
  }, [setSetting])

  const resolved = useMemo(() => resolveCharacterDisplaySettings({
    surface: 'homepage',
    homepageSettings: settings,
    characterTabSettings: tabSettings,
    currentBrowserState: { sortField, sortDirection },
  }), [settings, sortDirection, sortField, tabSettings])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), HOMEPAGE_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (!settings.enabled) return

    const invalidate = () => {
      // Both refs must be cleared: retryVersion reruns the fetch effect, and
      // clearing queryKeyRef forces it to start again at offset 0.
      settledQueryKeyRef.current = null
      queryKeyRef.current = null
      setRetryVersion((version) => version + 1)
    }

    const unsubscribers = [
      wsClient.on(EventType.CHARACTER_CREATED, invalidate),
      wsClient.on(EventType.CHARACTER_EDITED, invalidate),
      wsClient.on(EventType.CHARACTER_DELETED, invalidate),
      wsClient.on(EventType.CHARACTER_LIBRARY_CHANGED, invalidate),
    ]

    if (resolved.query.sortField === 'recent' || resolved.query.sortField === 'most_chats') {
      unsubscribers.push(
        wsClient.on(EventType.MESSAGE_SENT, invalidate),
        wsClient.on(EventType.CHAT_CREATED, invalidate),
        wsClient.on(EventType.CHAT_CHANGED, invalidate),
        wsClient.on(EventType.CHAT_DELETED, invalidate),
        wsClient.on(EventType.CHAT_FORKED, invalidate),
      )
    }

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [resolved.query.sortField, settings.enabled])

  useEffect(() => {
    if (!settings.enabled) return

    // The effect's dependency list re-runs on object identity (`favorites` is a fresh array
    // on unrelated store writes) and on the debounce settling to a value it already had.
    // The query key is what actually decides "this is a different query", so paging is only
    // thrown away when the user really changed something.
    const queryKey = characterQueryKey({
      search: debouncedSearch,
      tag: selectedTag,
      sortField: resolved.query.sortField,
      sortDirection: resolved.query.sortDirection,
      filter,
      chatId: activeChatId,
      favoriteIds: favorites,
    })
    // Settled, not merely started: the cleanup below aborts page 1 on *every* re-run, so a
    // run that early-returned on an unsettled key would leave the grid permanently empty.
    // StrictMode's mount/unmount/remount hits this on the very first paint.
    if (queryKey === settledQueryKeyRef.current) return
    const queryChanged = queryKey !== queryKeyRef.current
    queryKeyRef.current = queryKey

    // A changed query bumps the generation, which is what invalidates any response still in
    // flight for the previous one. A resumed (aborted, never-settled) query keeps its
    // generation so the retry commits normally.
    const generation = queryChanged
      ? pageStateRef.current.generation + 1
      : pageStateRef.current.generation
    loadingMoreRef.current = false
    setLoadingMore(false)

    if (filter === 'this-chat' && !activeChatId) {
      loadingRef.current = false
      settledQueryKeyRef.current = queryKey
      commitPageState(exhaustedCharacterPageState<CharacterSummary>(generation))
      setLoading(false)
      setError(null)
      return
    }

    const params: SummaryParams = {
      limit: HOMEPAGE_CHARACTER_PAGE_SIZE,
      search: debouncedSearch.trim() || undefined,
      tags: selectedTag || undefined,
      sort: resolved.query.sortField === 'shuffle' ? 'discover' : resolved.query.sortField,
      direction: resolved.query.sortDirection,
      filter: filter === 'favorites' ? 'favorites' : 'all',
      favorite_ids: filter === 'favorites' ? favorites.join(',') : undefined,
      scope: filter === 'shared' ? 'shared' : undefined,
      chat_id: filter === 'this-chat' ? activeChatId ?? undefined : undefined,
    }
    queryParamsRef.current = params

    // The accumulated rows stay on screen until page 1 of the new query lands (no flash of
    // empty grid), but `pageStateRef` is already blank — so `shouldLoadMore` sees
    // `received === 0` and the sentinel cannot fire a duplicate offset-0 request.
    if (queryChanged) pageStateRef.current = createCharacterPageState<CharacterSummary>(generation)
    const controller = new AbortController()
    loadingRef.current = true
    setLoading(true)
    setError(null)
    setExhausted(false)

    charactersApi.listSummaries({
      ...params,
      offset: nextPageOffset(pageStateRef.current),
    }, controller.signal).then((result) => {
      const next = applyCharacterPage(pageStateRef.current, {
        generation,
        data: result.data,
        total: result.total,
        pageSize: HOMEPAGE_CHARACTER_PAGE_SIZE,
      })
      if (next === pageStateRef.current) return
      settledQueryKeyRef.current = queryKey
      commitPageState(next)
    }).catch((err) => {
      if (!isAbortError(err)) {
        // Clearing the key lets the next effect run retry instead of short-circuiting on a
        // key it never successfully loaded.
        queryKeyRef.current = null
        setError(err instanceof Error ? err.message : 'Failed to load character library')
      }
    }).finally(() => {
      if (!controller.signal.aborted) {
        loadingRef.current = false
        setLoading(false)
      }
    })

    return () => controller.abort()
  }, [
    activeChatId,
    commitPageState,
    debouncedSearch,
    favorites,
    filter,
    resolved.query.sortDirection,
    resolved.query.sortField,
    selectedTag,
    retryVersion,
    settings.enabled,
  ])

  /**
   * Fetch the next page. Stable identity by construction: everything it reads is a ref, so
   * the IntersectionObserver in the component never has to re-subscribe because of it.
   */
  const loadMore = useCallback(() => {
    const state = pageStateRef.current
    if (!shouldLoadMore(state, { loading: loadingRef.current, loadingMore: loadingMoreRef.current })) {
      return
    }
    const { generation } = state
    loadingMoreRef.current = true
    setLoadingMore(true)
    const controller = new AbortController()

    charactersApi.listSummaries({
      ...queryParamsRef.current,
      offset: nextPageOffset(state),
    }, controller.signal).then((result) => {
      const next = applyCharacterPage(pageStateRef.current, {
        generation,
        data: result.data,
        total: result.total,
        pageSize: HOMEPAGE_CHARACTER_PAGE_SIZE,
      })
      if (next === pageStateRef.current) return
      commitPageState(next)
    }).catch((err) => {
      if (!isAbortError(err)) {
        console.error('[HomepageCharacterLibrary] Failed to load more characters:', err)
      }
    }).finally(() => {
      // A reset already cleared the flag and owns the spinner now; don't stomp it.
      if (pageStateRef.current.generation !== generation) return
      loadingMoreRef.current = false
      setLoadingMore(false)
    })
  }, [commitPageState])

  useEffect(() => {
    if (!settings.enabled) return
    charactersApi.listTags().then(setTags).catch((err) => {
      console.error('[HomepageCharacterLibrary] Failed to load tags:', err)
    })
  }, [settings.enabled])

  const selectedCharacterId = settings.lastSelectedCharacterId
    && characters.some((character) => character.id === settings.lastSelectedCharacterId)
    ? settings.lastSelectedCharacterId
    : characters[0]?.id ?? null
  const selectedCharacter = characters.find((character) => character.id === selectedCharacterId) ?? null

  useEffect(() => {
    if (!selectedCharacterId || !panelOpen) {
      setPreview(null)
      return
    }
    const controller = new AbortController()
    setPreview(null)
    setPreviewLoading(true)
    charactersApi.getHomepagePreview(selectedCharacterId, controller.signal)
      .then(setPreview)
      .catch((err) => {
        if (!isAbortError(err)) console.error('[HomepageCharacterLibrary] Failed to load preview:', err)
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false)
      })
    return () => controller.abort()
  }, [panelOpen, selectedCharacterId])

  const selectCharacter = useCallback((id: string) => {
    setPanelOpen(true)
    updateSettings({ lastSelectedCharacterId: id })
  }, [updateSettings])

  const openCharacterChat = useCallback(async (character: CharacterSummary) => {
    if (openingCharacterIdRef.current) return
    openingCharacterIdRef.current = character.id
    setOpeningCharacterId(character.id)
    selectCharacter(character.id)

    try {
      const current = previewRef.current
      const targetPreview = current?.character.id === character.id
        ? current
        : await charactersApi.getHomepagePreview(character.id)
      if (targetPreview.open_chat_id) {
        navigate(`/chat/${targetPreview.open_chat_id}`)
        return
      }
      const chat = await chatsApi.create({ character_id: character.id })
      navigate(`/chat/${chat.id}`)
    } catch (err) {
      console.error('[HomepageCharacterLibrary] Failed to open chat:', err)
    } finally {
      openingCharacterIdRef.current = null
      setOpeningCharacterId(null)
    }
  }, [navigate, selectCharacter])

  const editCharacter = useCallback(async (id: string) => {
    const editRequestId = ++editRequestIdRef.current
    setError(null)
    try {
      const character = await charactersApi.get(id)
      if (editRequestId !== editRequestIdRef.current) return
      updateCharacter(character.id, character)
      setEditingCharacterId(id)
    } catch (err) {
      if (editRequestId !== editRequestIdRef.current) return
      console.error('[HomepageCharacterLibrary] Failed to load character for editing:', err)
      setError(err instanceof Error ? err.message : 'Failed to load character for editing')
    }
  }, [setEditingCharacterId, updateCharacter])

  const setPanelPinned = useCallback((panelPinned: boolean) => {
    updateSettings({ panelPinned })
  }, [updateSettings])

  const setPanelWidth = useCallback((panelWidth: number) => {
    updateSettings({ panelWidth: clampHomepagePanelWidth(panelWidth) })
  }, [updateSettings])

  const setPanelImageHeight = useCallback((panelImageHeight: number) => {
    updateSettings({ panelImageHeight: clampHomepagePanelImageHeight(panelImageHeight) })
  }, [updateSettings])

  const selectSortField = useCallback((nextSortField: CharacterSortField) => {
    setSortField(nextSortField)
    if (nextSortField === 'most_chats') setSortDirection('desc')
  }, [])

  const closePanel = useCallback(() => setPanelOpen(false), [])
  const openSettings = useCallback(
    () => openSettingsModal('productivity', { anchorId: 'homepage-character-library-settings' }),
    [openSettingsModal],
  )
  const retry = useCallback(() => {
    queryKeyRef.current = null
    setError(null)
    setRetryVersion((value) => value + 1)
  }, [])

  return {
    settings,
    display: resolved.display,
    characters,
    tags,
    selectedCharacter,
    preview,
    panelOpen,
    loading,
    loadingMore,
    hasMore: !exhausted,
    loadMore,
    previewLoading,
    error,
    retry,
    filter,
    setFilter,
    search,
    setSearch,
    selectedTag,
    setSelectedTag,
    sortField,
    setSortField: selectSortField,
    sortDirection,
    setSortDirection,
    activeChatId,
    openingCharacterId,
    openCharacterChat,
    editCharacter,
    selectCharacter,
    closePanel,
    openSettings,
    setPanelPinned,
    setPanelWidth,
    setPanelImageHeight,
  }
}
