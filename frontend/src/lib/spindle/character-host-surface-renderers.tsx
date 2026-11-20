import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { chatsApi } from '@/api/chats'
import { charactersApi, type SummaryParams } from '@/api/characters'
import { worldBooksApi } from '@/api/world-books'
import type { Character, CharacterSummary, ChatSummary } from '@/types/api'
import CharacterCard from '@/components/panels/character-browser/CharacterCard'
import CharacterGrid from '@/components/panels/character-browser/CharacterGrid'
import { HomepageCharacterLibrary } from '@/components/landing/HomepageCharacterLibrary'
import { useStore } from '@/store'
import { getCharacterWorldBookIds } from '@/utils/character-world-books'
import {
  registerHostSurfaceRenderer,
  type HostSurfaceRenderContext,
  type HostSurfaceRenderer,
} from './host-surface-registry'

const MAX_GRID_CHARACTERS = 100
const MAX_CHAT_PREVIEW_LENGTH = 280
const DEFAULT_PREVIEW_IMAGE_HEIGHT = 320
const MAX_WORLD_BOOKS = 1000

const surfaceStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minWidth: 0,
}

const actionRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
}

const buttonStyle: CSSProperties = {
  minHeight: 32,
  padding: '6px 10px',
  border: '1px solid var(--lumiverse-border, currentColor)',
  borderRadius: 6,
  background: 'var(--lumiverse-fill-subtle, transparent)',
  color: 'inherit',
  cursor: 'pointer',
}

type ResourceState<T> = {
  value: T | null
  loading: boolean
  error: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError'
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function isCharacterLike(value: unknown): value is Character {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
}

function isChatSummary(value: unknown): value is ChatSummary {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
}

function normalizeCharacterSummary(value: unknown): CharacterSummary | null {
  if (!isCharacterLike(value)) return null
  const row = value as unknown as Partial<CharacterSummary>
  return {
    id: value.id,
    name: value.name,
    description: typeof row.description === 'string' ? row.description : '',
    preview_description: typeof row.preview_description === 'string'
      ? row.preview_description
      : typeof row.description === 'string' ? row.description : '',
    creator: typeof row.creator === 'string' ? row.creator : '',
    folder: typeof row.folder === 'string' ? row.folder : '',
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    image_id: typeof row.image_id === 'string' ? row.image_id : null,
    library_scope: row.library_scope === 'shared' ? 'shared' : 'mine',
    created_at: typeof row.created_at === 'number' ? row.created_at : 0,
    updated_at: typeof row.updated_at === 'number' ? row.updated_at : 0,
    has_alternate_greetings: row.has_alternate_greetings === true,
  }
}

type PreviewWorldBook = {
  id: string
  name: string
}

let worldBookSweepPromise: Promise<PreviewWorldBook[]> | null = null

function normalizeWorldBook(value: unknown): PreviewWorldBook | null {
  if (!isRecord(value)) return null
  const id = stringValue(value.id)
  const name = stringValue(value.name)
  return id && name ? { id, name } : null
}

function loadWorldBookSweep(): Promise<PreviewWorldBook[]> {
  if (!worldBookSweepPromise) {
    worldBookSweepPromise = worldBooksApi
      .list({ limit: MAX_WORLD_BOOKS, offset: 0 })
      .then((result) => (
        Array.isArray(result?.data)
          ? result.data
            .map(normalizeWorldBook)
            .filter((book): book is PreviewWorldBook => book !== null)
            .slice(0, MAX_WORLD_BOOKS)
          : []
      ))
      .catch((error: unknown) => {
        worldBookSweepPromise = null
        throw error
      })
  }
  return worldBookSweepPromise
}

/**
 * Resource loading is deliberately local to a mounted renderer. The core APIs used by
 * these surfaces predate caller AbortSignals, so the controller still provides an
 * explicit generation boundary and prevents late promises from committing after an
 * update or unmount.
 */
function useGenerationResource<T>(
  key: string | null,
  loader: (signal: AbortSignal) => Promise<T>,
): ResourceState<T> {
  const [state, setState] = useState<ResourceState<T>>({ value: null, loading: false, error: null })
  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const loaderRef = useRef(loader)
  const controllersRef = useRef(new Set<AbortController>())
  loaderRef.current = loader

  useEffect(() => {
    const controllers = controllersRef.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      for (const controller of controllers) controller.abort()
      controllers.clear()
    }
  }, [])

  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    const controller = new AbortController()
    const controllers = controllersRef.current
    controllers.add(controller)

    if (!key) {
      setState({ value: null, loading: false, error: null })
      return () => {
        controller.abort()
        controllers.delete(controller)
        if (generationRef.current === generation) generationRef.current += 1
      }
    }

    setState({ value: null, loading: true, error: null })
    Promise.resolve()
      .then(() => loaderRef.current(controller.signal))
      .then((value) => {
        if (!mountedRef.current || controller.signal.aborted || generationRef.current !== generation) return
        setState({ value, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || controller.signal.aborted || generationRef.current !== generation) return
        setState({ value: null, loading: false, error: isAbortError(error) ? null : errorMessage(error, 'Unable to load this surface') })
      })
      .finally(() => {
        controllers.delete(controller)
      })

    return () => {
      controller.abort()
      controllers.delete(controller)
      if (generationRef.current === generation) generationRef.current += 1
    }
  }, [key])

  return state
}

function CardState({
  state,
  onRetry,
}: {
  state: ResourceState<Character>
  onRetry: () => void
}): ReactElement | null {
  if (state.loading) {
    return <div data-state="loading" role="status" aria-live="polite">Loading character...</div>
  }
  if (state.error) {
    return (
      <div data-state="error" role="alert">
        <span>{state.error}</span>
        <button type="button" style={buttonStyle} onClick={onRetry}>Retry</button>
      </div>
    )
  }
  if (!state.value) {
    return <div data-state="empty">Character unavailable.</div>
  }
  return null
}

export function CharacterCardSurface({
  characterId,
  batchMode,
  isSelected,
  context,
}: {
  characterId: string | null
  batchMode: boolean
  isSelected: boolean
  context: HostSurfaceRenderContext
}): ReactElement {
  const [retryNonce, setRetryNonce] = useState(0)
  const loadCharacter = useCallback(async (_signal: AbortSignal) => {
    if (!characterId) throw new Error('Character unavailable')
    const character = await charactersApi.get(characterId)
    if (!isCharacterLike(character) || character.id !== characterId) throw new Error('Character unavailable')
    return character
  }, [characterId])
  const state = useGenerationResource(characterId ? `${characterId}:${retryNonce}` : null, loadCharacter)
  const favorites = useStore((store) => store.favorites)

  const emitCharacter = useCallback((event: string, id: string) => {
    context.emit(event, { characterId: id })
  }, [context])

  const card = state.value ? (
    <CharacterCard
      character={state.value}
      isFavorite={favorites.includes(state.value.id)}
      isSelected={isSelected}
      batchMode={batchMode}
      useLargeTier
      onOpen={(character) => emitCharacter('open', character.id)}
      onEdit={(id) => emitCharacter('edit', id)}
      onToggleFavorite={(id) => emitCharacter('toggleFavorite', id)}
      onToggleBatch={(id) => emitCharacter('toggleBatch', id)}
    />
  ) : null

  return (
    <section
      data-surface-id="character_card"
      aria-label="Character card"
      aria-busy={state.loading}
      style={surfaceStyle}
    >
      <CardState state={state} onRetry={() => setRetryNonce((value) => value + 1)} />
      {card}
    </section>
  )
}

interface CharacterLibraryGridState {
  characters: CharacterSummary[]
  total: number
}

function useCharacterLibraryGrid(props: Record<string, unknown>) {
  const [retryNonce, setRetryNonce] = useState(0)
  const scopeValue = stringValue(props.scope)
  const scope = scopeValue === 'mine' || scopeValue === 'shared' ? scopeValue : undefined
  const chatId = stringValue(props.chatId)
  const filterTab = stringValue(props.filterTab) ?? 'characters'
  const sortField = stringValue(props.sortField) ?? 'recent'
  const sortDirection = props.sortDirection === 'asc' ? 'asc' : 'desc'
  const search = stringValue(props.search)?.trim() ?? ''
  const excludeTags = useMemo(() => (
    Array.isArray(props.excludeTags)
      ? props.excludeTags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      : []
  ), [props.excludeTags])
  const selectedCharacterId = stringValue(props.selectedCharacterId)
  const viewMode = stringValue(props.viewMode) ?? 'grid'
  const explicitCharacters = useMemo<CharacterSummary[] | null>(() => {
    if (!Array.isArray(props.characters)) return null
    return props.characters
      .map(normalizeCharacterSummary)
      .filter((character): character is CharacterSummary => character !== null)
      .slice(0, MAX_GRID_CHARACTERS)
  }, [props.characters])
  const queryParams = useMemo<SummaryParams>(() => {
    const params: SummaryParams = {
      limit: MAX_GRID_CHARACTERS,
      offset: 0,
      sort: sortField,
      direction: sortDirection,
    }
    if (scope) params.scope = scope
    if (chatId) params.chat_id = chatId
    if (filterTab) {
      params.filter = filterTab === 'favorites'
        ? 'favorites'
        : filterTab === 'characters'
          ? 'non-favorites'
          : filterTab
    }
    if (search) params.search = search
    if (excludeTags.length > 0) params.exclude_tags = excludeTags.join(',')
    return params
  }, [chatId, excludeTags, filterTab, scope, search, sortDirection, sortField])
  const queryKey = useMemo(() => JSON.stringify({ queryParams, retryNonce }), [queryParams, retryNonce])
  const loadGrid = useCallback(async (signal: AbortSignal): Promise<CharacterLibraryGridState> => {
    const result = await charactersApi.listSummaries(queryParams, signal)
    const characters = Array.isArray(result?.data)
      ? result.data
        .map(normalizeCharacterSummary)
        .filter((character): character is CharacterSummary => character !== null)
        .slice(0, MAX_GRID_CHARACTERS)
      : []
    return { characters, total: typeof result?.total === 'number' ? result.total : characters.length }
  }, [queryParams])
  const fetchedState = useGenerationResource(explicitCharacters === null ? queryKey : null, loadGrid)
  const state: ResourceState<CharacterLibraryGridState> = explicitCharacters === null
    ? fetchedState
    : { value: { characters: explicitCharacters, total: explicitCharacters.length }, loading: false, error: null }
  const characters = state.value?.characters ?? []
  const favorites = useStore((store) => store.favorites)
  const selected = selectedCharacterId ? [selectedCharacterId] : []

  return {
    state,
    characters,
    favorites: Array.isArray(favorites) ? favorites : [],
    batchSelected: selected,
    viewMode,
    retry: () => setRetryNonce((value) => value + 1),
  }
}

export function CharacterLibraryGridSurface({
  props,
  context,
}: {
  props: Record<string, unknown>
  context: HostSurfaceRenderContext
}): ReactElement {
  const grid = useCharacterLibraryGrid(props)
  const { state, characters, favorites, batchSelected, viewMode } = grid

  const emitCharacter = useCallback((event: string, id: string) => {
    context.emit(event, { characterId: id })
  }, [context])

  const handleOpen = useCallback((character: Character | CharacterSummary) => {
    emitCharacter('select', character.id)
    emitCharacter('open', character.id)
  }, [emitCharacter])

  const showLoading = state.loading
  const showError = !state.loading && !!state.error
  const showEmpty = !state.loading && !state.error && characters.length === 0

  return (
    <section
      data-surface-id="character_library_grid"
      aria-label="Character library"
      aria-busy={state.loading}
      style={surfaceStyle}
    >
      {showLoading && <div data-state="loading" role="status" aria-live="polite">Loading characters...</div>}
      {showError && (
        <div data-state="error" role="alert">
          <span>{state.error}</span>
          <button type="button" style={buttonStyle} onClick={grid.retry}>Retry</button>
        </div>
      )}
      {showEmpty && (
        <div data-state="empty">
          <p>No characters found.</p>
          <button type="button" style={buttonStyle} onClick={grid.retry}>Refresh characters</button>
        </div>
      )}
      {characters.length > 0 && (
        <CharacterGrid
          characters={characters}
          favorites={favorites}
          batchMode={false}
          batchSelected={batchSelected}
          singleColumn={viewMode === 'single'}
          onOpen={handleOpen}
          onEdit={(id) => emitCharacter('edit', id)}
          onToggleFavorite={(id) => emitCharacter('toggleFavorite', id)}
          onToggleBatch={(id) => emitCharacter('toggleBatch', id)}
        />
      )}
    </section>
  )
}

async function loadAttachedWorldBooks(character: Character, signal: AbortSignal): Promise<PreviewWorldBook[]> {
  const ids = getCharacterWorldBookIds(character.extensions)
  if (ids.length === 0) return []
  if (signal.aborted) {
    const error = new Error('Aborted')
    error.name = 'AbortError'
    throw error
  }
  const books = await loadWorldBookSweep()
  if (signal.aborted) {
    const error = new Error('Aborted')
    error.name = 'AbortError'
    throw error
  }
  const attachedIds = new Set(ids)
  return books.filter((book) => attachedIds.has(book.id))
}

interface PreviewResource {
  character: Character
  chats: ChatSummary[]
  worldBooks: PreviewWorldBook[]
}

function PreviewState({
  state,
  onRetry,
}: {
  state: ResourceState<PreviewResource>
  onRetry: () => void
}): ReactElement | null {
  if (state.loading) {
    return <div data-state="loading" role="status" aria-live="polite">Loading preview...</div>
  }
  if (state.error) {
    return (
      <div data-state="error" role="alert">
        <span>{state.error}</span>
        <button type="button" style={buttonStyle} onClick={onRetry}>Retry</button>
      </div>
    )
  }
  if (!state.value) return <div data-state="empty">Character preview unavailable.</div>
  return null
}

function chatPreview(chat: ChatSummary): string {
  const preview = typeof chat.last_message_preview === 'string' ? chat.last_message_preview : ''
  return preview.slice(0, MAX_CHAT_PREVIEW_LENGTH)
}

export function CharacterPreviewPanelSurface({
  characterId,
  imageHeight,
  pinned,
  context,
}: {
  characterId: string | null
  imageHeight: number
  pinned: boolean
  context: HostSurfaceRenderContext
}): ReactElement {
  const [retryNonce, setRetryNonce] = useState(0)
  const loadPreview = useCallback(async (signal: AbortSignal): Promise<PreviewResource> => {
    if (!characterId) throw new Error('Character preview unavailable')
    const [character, chats] = await Promise.all([
      charactersApi.get(characterId),
      chatsApi.listCharacterChats(characterId),
    ])
    if (!isCharacterLike(character) || character.id !== characterId) throw new Error('Character preview unavailable')
    const safeChats = Array.isArray(chats) ? chats.filter(isChatSummary).slice(0, MAX_GRID_CHARACTERS) : []
    const worldBooks = await loadAttachedWorldBooks(character, signal)
    return { character, chats: safeChats, worldBooks }
  }, [characterId])
  const state = useGenerationResource(
    characterId ? `${characterId}:${retryNonce}` : null,
    loadPreview,
  )
  const height = Math.max(64, numberValue(imageHeight, DEFAULT_PREVIEW_IMAGE_HEIGHT))
  const name = state.value?.character.name ?? 'Character preview'
  const emit = useCallback((event: string, payload: Record<string, string | boolean>) => {
    context.emit(event, payload)
  }, [context])
  const avatarUrl = state.value ? charactersApi.avatarUrl(state.value.character.id) : null

  return (
    <aside
      data-surface-id="character_preview_panel"
      aria-label={`${name} preview`}
      aria-busy={state.loading}
      style={surfaceStyle}
    >
      <div style={actionRowStyle}>
        <button
          type="button"
          style={buttonStyle}
          aria-label={pinned ? 'Unpin preview' : 'Pin preview'}
          title={pinned ? 'Unpin preview' : 'Pin preview'}
          onClick={() => characterId && emit('pin', { characterId, pinned: !pinned })}
        >
          {pinned ? 'Unpin' : 'Pin'}
        </button>
        <button
          type="button"
          style={buttonStyle}
          aria-label="Close preview"
          title="Close preview"
          onClick={() => characterId && emit('close', { characterId })}
        >
          Close
        </button>
      </div>

      <PreviewState state={state} onRetry={() => setRetryNonce((value) => value + 1)} />
      {state.value && (
        <>
          <div>
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={state.value.character.name}
                style={{ width: '100%', height, objectFit: 'cover' }}
              />
            ) : (
              <div role="img" aria-label={`${state.value.character.name} avatar unavailable`} style={{ height }}>
                {state.value.character.name.slice(0, 1).toUpperCase()}
              </div>
            )}
          </div>
          <header>
            <h2>{state.value.character.name}</h2>
            {state.value.character.creator && <p>{state.value.character.creator}</p>}
          </header>
          {state.value.character.description && (
            <p>{state.value.character.description}</p>
          )}
          {state.value.character.tags?.length > 0 && (
            <div aria-label="Character tags">
              {state.value.character.tags.map((tag) => <span key={tag}>{tag}</span>)}
            </div>
          )}
          <section aria-labelledby="character-preview-world-books">
            <h3 id="character-preview-world-books">World books</h3>
            {state.value.worldBooks.length === 0 ? (
              <p data-state="empty">No world books attached.</p>
            ) : (
              <ul aria-label="Attached world books">
                {state.value.worldBooks.map((book) => (
                  <li key={book.id}>
                    <button type="button" style={buttonStyle} onClick={() => emit('openWorldBook', { bookId: book.id })}>
                      {book.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <div style={actionRowStyle}>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => emit('edit', { characterId: state.value!.character.id })}
            >
              Edit character
            </button>
          </div>
          <section aria-labelledby="character-preview-chats">
            <h3 id="character-preview-chats">Chats</h3>
            {state.value.chats.length === 0 ? (
              <p data-state="empty">No chats for this character.</p>
            ) : (
              <ul>
                {state.value.chats.map((chat) => (
                  <li key={chat.id}>
                    <button
                      type="button"
                      style={buttonStyle}
                      onClick={() => emit('openChat', { characterId: state.value!.character.id, chatId: chat.id })}
                    >
                      {chat.name || 'Untitled chat'}
                    </button>
                    {chatPreview(chat) && <p>{chatPreview(chat)}</p>}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              style={buttonStyle}
              onClick={() => emit('openChat', { characterId: state.value!.character.id })}
            >
              Start chat
            </button>
          </section>
        </>
      )}
    </aside>
  )
}

const characterCardRenderer: HostSurfaceRenderer = (props, context) => (
  <CharacterCardSurface
    characterId={stringValue(props.characterId)}
    batchMode={booleanValue(props.batchMode, false)}
    isSelected={booleanValue(props.isSelected, false)}
    context={context}
  />
)

const characterLibraryGridRenderer: HostSurfaceRenderer = (props, context) => (
  <CharacterLibraryGridSurface props={props} context={context} />
)

const characterPreviewPanelRenderer: HostSurfaceRenderer = (props, context) => (
  <CharacterPreviewPanelSurface
    characterId={stringValue(props.characterId)}
    imageHeight={numberValue(props.imageHeight, DEFAULT_PREVIEW_IMAGE_HEIGHT)}
    pinned={booleanValue(props.pinned, false)}
    context={context}
  />
)

const unregisterRenderers = [
  registerHostSurfaceRenderer('character_card', characterCardRenderer),
  registerHostSurfaceRenderer('character_library_grid', characterLibraryGridRenderer),
  registerHostSurfaceRenderer('character_preview_panel', characterPreviewPanelRenderer),
  registerHostSurfaceRenderer('homepage_character_library', () => <HomepageCharacterLibrary />),
]
if (import.meta.hot) import.meta.hot.dispose(() => unregisterRenderers.forEach(unregister => unregister()))
