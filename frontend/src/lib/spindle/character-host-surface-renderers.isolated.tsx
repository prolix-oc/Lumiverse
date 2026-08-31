/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import type { HostSurfaceProps } from './host-surface-registry'

const getCharacter = jest.fn()
const listSummaries = jest.fn()
const getHomepagePreview = jest.fn(() => {
  throw new Error('homepage-preview must not be called by character_preview_panel')
})
const avatarUrl = jest.fn(() => '/avatar.png')
const listCharacterChats = jest.fn()
const listWorldBooks = jest.fn()
const cardPropsSeen: Array<Record<string, any>> = []
const gridPropsSeen: Array<Record<string, any>> = []
const storeState = { favorites: [] as string[] }

function MockCharacterCard(props: Record<string, any>) {
  cardPropsSeen.push(props)
  const character = props.character as { id: string; name: string }
  return (
    <article data-testid="native-character-card" data-character-id={character.id}>
      <span>{character.name}</span>
      <button type="button" data-action="open" onClick={() => props.onOpen?.(character)}>Open</button>
      <button type="button" data-action="edit" onClick={() => props.onEdit?.(character.id)}>Edit</button>
      <button type="button" data-action="toggleFavorite" onClick={() => props.onToggleFavorite?.(character.id)}>Favorite</button>
      <button type="button" data-action="toggleBatch" onClick={() => props.onToggleBatch?.(character.id)}>Select</button>
    </article>
  )
}

function MockCharacterGrid(props: Record<string, any>) {
  gridPropsSeen.push(props)
  const characters = (props.characters ?? []) as Array<{ id: string; name: string }>
  const selected = props.selectedCharacterId ?? props.batchSelected?.[0] ?? ''
  return (
    <section data-testid="native-character-grid" data-selected-character-id={selected}>
      {characters.map((character) => (
        <article
          key={character.id}
          data-character-id={character.id}
          data-selected={String(props.batchSelected?.includes(character.id) ?? false)}
        >
          <span>{character.name}</span>
          <button type="button" data-action="select" onClick={() => props.onOpen?.(character)}>
            Select {character.name}
          </button>
          <button type="button" data-action="open" onClick={() => props.onOpen?.(character)}>
            Open {character.name}
          </button>
        </article>
      ))}
    </section>
  )
}

mock.module('@/api/characters', () => ({
  charactersApi: {
    get: getCharacter,
    listSummaries,
    getHomepagePreview,
    avatarUrl,
  },
}))
mock.module('@/api/chats', () => ({
  chatsApi: {
    listCharacterChats,
  },
}))
mock.module('@/api/world-books', () => ({
  worldBooksApi: {
    list: listWorldBooks,
  },
}))
mock.module('@/store', () => ({
  useStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}))
mock.module('@/components/panels/character-browser/CharacterCard', () => ({
  default: MockCharacterCard,
}))
mock.module('@/components/panels/character-browser/CharacterGrid', () => ({
  default: MockCharacterGrid,
}))
mock.module('@/lib/avatarUrls', () => ({
  getCharacterAvatarLargeUrl: () => '/avatar-large.png',
  getCharacterAvatarLargeUrlById: () => '/avatar-large.png',
  getCharacterAvatarThumbUrl: () => '/avatar-thumb.png',
  getCharacterAvatarThumbUrlById: () => '/avatar-thumb.png',
}))
mock.module('@/lib/tagColors', () => ({
  getTagColor: () => ({ bg: '#111', text: '#fff', border: '#222' }),
  getTagColorVar: () => '17,17,17',
}))
mock.module('@/components/shared/FormComponents', () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => <button {...props}>{children}</button>,
  TextInput: (props: Record<string, unknown>) => <input {...props} />,
  TextArea: (props: Record<string, unknown>) => <textarea {...props} />,
}))
mock.module('@/components/panels/LoomBuilder', () => ({
  ControlledLoomBlockEditor: () => null,
}))
mock.module('@/components/panels/connection-manager/ModelCombobox', () => ({
  default: () => null,
}))
mock.module('lucide-react', () => {
  const Icon = () => <span aria-hidden="true" />
  return {
    AlertCircle: Icon,
    AlertTriangle: Icon,
    ArrowDown: Icon,
    ArrowLeft: Icon,
    ArrowUp: Icon,
    ArrowUpDown: Icon,
    BookOpen: Icon,
    Bot: Icon,
    Braces: Icon,
    Camera: Icon,
    Check: Icon,
    CheckCircle: Icon,
    ChevronDown: Icon,
    ChevronLeft: Icon,
    ChevronRight: Icon,
    ChevronUp: Icon,
    Copy: Icon,
    Dice1: Icon,
    Download: Icon,
    Edit2: Icon,
    Edit3: Icon,
    Eye: Icon,
    EyeOff: Icon,
    FileText: Icon,
    FolderOpen: Icon,
    GripVertical: Icon,
    Hash: Icon,
    Image: Icon,
    Info: Icon,
    Layers: Icon,
    Link: Icon,
    Link2: Icon,
    Loader2: Icon,
    Lock: Icon,
    Maximize2: Icon,
    MessageSquare: Icon,
    Mic: Icon,
    Minimize2: Icon,
    Minus: Icon,
    MoreVertical: Icon,
    Pencil: Icon,
    Pin: Icon,
    PinOff: Icon,
    Plus: Icon,
    RefreshCw: Icon,
    Replace: Icon,
    RotateCcw: Icon,
    Search: Icon,
    Settings: Icon,
    Settings2: Icon,
    ArrowBigDown: Icon,
    ArrowBigUp: Icon,
    BetweenHorizontalEnd: Icon,
    BetweenHorizontalStart: Icon,
    CheckSquare: Icon,
    Globe: Icon,
    MapPin: Icon,
    MoveRight: Icon,
    Plug: Icon,
    Sliders: Icon,
    Tag: Icon,
    User: Icon,
    UserRound: Icon,
    Users: Icon,
    Shield: Icon,
    Square: Icon,
    Star: Icon,
    StopCircle: Icon,
    Trash2: Icon,
    Unlink: Icon,
    Upload: Icon,
    Volume2: Icon,
    Wifi: Icon,
    WifiOff: Icon,
    Wrench: Icon,
    X: Icon,
    XCircle: Icon,
    Zap: Icon,
  }
})

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis
const originalGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  HTMLButtonElement: globalThis.HTMLButtonElement,
  HTMLInputElement: globalThis.HTMLInputElement,
  Node: globalThis.Node,
  Event: globalThis.Event,
  MouseEvent: globalThis.MouseEvent,
  KeyboardEvent: globalThis.KeyboardEvent,
  FocusEvent: globalThis.FocusEvent,
  DOMRect: globalThis.DOMRect,
  MutationObserver: globalThis.MutationObserver,
  ResizeObserver: globalThis.ResizeObserver,
  IntersectionObserver: globalThis.IntersectionObserver,
  getComputedStyle: globalThis.getComputedStyle,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
}

Object.assign(domWindow, {
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  },
  cancelAnimationFrame: () => {},
})

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  DOMRect: domWindow.DOMRect,
  MutationObserver: domWindow.MutationObserver,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
if (!domWindow.PointerEvent) {
  class TestPointerEvent extends domWindow.MouseEvent {}
  Object.assign(domWindow, { PointerEvent: TestPointerEvent })
  Object.assign(globalThis, { PointerEvent: TestPointerEvent })
}
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let createComponentsHelper: typeof import('./components-helper')['createComponentsHelper']
let destroyAllComponentsForExtension: typeof import('./components-helper')['destroyAllComponentsForExtension']
let registerLiveRoot: typeof import('./live-root-registry')['registerLiveRoot']
let clearLiveRootsForExtension: typeof import('./live-root-registry')['clearLiveRootsForExtension']

const EXTENSION_ID = 'character-display-renderer-tests'
const unregisterRoots: Array<() => void> = []

type CharacterSummary = {
  id: string
  name: string
  creator: string
  folder: string
  tags: string[]
  image_id: string | null
  library_scope: 'mine' | 'shared'
  created_at: number
  updated_at: number
  has_alternate_greetings: boolean
}

type Character = CharacterSummary & {
  avatar_path: string | null
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  creator_notes: string
  system_prompt: string
  post_history_instructions: string
  alternate_greetings: string[]
  talkativeness: number
  extensions: Record<string, unknown>
}

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function summary(id: string, name = `Character ${id}`): CharacterSummary {
  return {
    id,
    name,
    creator: 'Test creator',
    folder: '',
    tags: ['one', 'two'],
    image_id: null,
    library_scope: 'mine',
    created_at: 1,
    updated_at: 1,
    has_alternate_greetings: false,
  }
}

function character(id: string, name = `Character ${id}`): Character {
  return {
    ...summary(id, name),
    avatar_path: null,
    description: 'Description',
    personality: 'Personality',
    scenario: 'Scenario',
    first_mes: 'Hello',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    talkativeness: 0.5,
    extensions: {},
  }
}

function browserSummary(id: string, name: string) {
  return {
    ...summary(id, name),
    library_scope: 'shared' as const,
  }
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  })
}

async function settle<T>(pending: Deferred<T>, value: T) {
  await act(async () => {
    pending.resolve(value)
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function reject<T>(pending: Deferred<T>, error: unknown) {
  await act(async () => {
    pending.reject(error)
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

function findButton(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === text)
}

function eventLog(handle: { on(event: string, handler: (payload: unknown) => void): () => void }) {
  const events: Array<{ event: string; payload: unknown }> = []
  const off = ['open', 'edit', 'toggleFavorite', 'toggleBatch', 'select', 'close', 'pin', 'openChat'].map((event) => (
    handle.on(event, (payload) => events.push({ event, payload }))
  ))
  return { events, off }
}

async function mountSurface(surfaceId: string, props: HostSurfaceProps) {
  const host = document.createElement('div')
  host.setAttribute('data-spindle-extension-root', EXTENSION_ID)
  document.body.append(host)
  unregisterRoots.push(registerLiveRoot(EXTENSION_ID, host, null, 1))
  const helper = createComponentsHelper(
    EXTENSION_ID,
    'character-display-renderer-tests',
    async () => ({ categories: [] }),
    1,
  )
  const handle = helper.mountHostSurface(host, surfaceId, props)
  await flush()
  return { host, handle }
}

beforeAll(async () => {
  ;({ createComponentsHelper, destroyAllComponentsForExtension } = await import('./components-helper'))
  ;({ registerLiveRoot, clearLiveRootsForExtension } = await import('./live-root-registry'))
  await import('./character-host-surface-renderers')
})

afterEach(async () => {
  destroyAllComponentsForExtension(EXTENSION_ID)
  for (const unregister of unregisterRoots.splice(0)) unregister()
  clearLiveRootsForExtension(EXTENSION_ID)
  document.body.replaceChildren()
  getCharacter.mockReset()
  listSummaries.mockReset()
  listCharacterChats.mockReset()
  listWorldBooks.mockReset()
  cardPropsSeen.splice(0)
  gridPropsSeen.splice(0)
  browserSummaryCache = [browserSummary('grid-1', 'Grid character')]
  await flush()
})

afterAll(() => {
  Object.assign(globalThis, originalGlobals)
})

let browserSummaryCache = [browserSummary('grid-1', 'Grid character')]

mock.module('@/hooks/useCharacterBrowser', () => ({
  useCharacterBrowser: () => ({
    characters: browserSummaryCache,
    favorites: [],
    batchMode: false,
    batchSelected: [],
    viewMode: 'grid',
    loading: false,
    error: null,
    importError: null,
    refreshBrowser: jest.fn(),
  }),
}))

describe('character host surface renderers', () => {
  test('character_card loads an ordinary character and emits JSON actions', async () => {
    const pending = deferred<Character>()
    getCharacter.mockReturnValueOnce(pending.promise)
    const { host, handle } = await mountSurface('character_card', { characterId: 'card-1' })
    const { events, off } = eventLog(handle)

    expect(getCharacter).toHaveBeenCalledWith('card-1')
    expect(host.querySelector('[role="status"]')).not.toBeNull()

    await settle(pending, character('card-1', 'Card one'))
    expect(host.querySelector('[data-testid="native-character-card"]')?.textContent).toContain('Card one')

    await click(host.querySelector('[data-action="open"]')!)
    await click(host.querySelector('[data-action="edit"]')!)
    await click(host.querySelector('[data-action="toggleFavorite"]')!)
    await click(host.querySelector('[data-action="toggleBatch"]')!)

    expect(events.map(({ event }) => event)).toEqual(['open', 'edit', 'toggleFavorite', 'toggleBatch'])
    for (const { payload } of events) {
      expect(payload).toEqual(expect.objectContaining({ characterId: 'card-1' }))
      expect(() => JSON.stringify(payload)).not.toThrow()
    }
    expect(cardPropsSeen.at(-1)?.character).toEqual(expect.objectContaining({ id: 'card-1' }))
    for (const unsubscribe of off) unsubscribe()
  })

  test('character_card reports loading and ordinary API errors, ignores aborts, and does not update after unmount', async () => {
    const loading = deferred<Character>()
    getCharacter.mockReturnValueOnce(loading.promise)
    const first = await mountSurface('character_card', { characterId: 'card-loading' })
    expect(first.host.querySelector('[role="status"]')).not.toBeNull()

    first.handle.destroy()
    await settle(loading, character('card-loading'))
    expect(first.host.querySelector('[data-testid="native-character-card"]')).toBeNull()

    getCharacter.mockRejectedValueOnce(new Error('character unavailable'))
    const failed = await mountSurface('character_card', { characterId: 'card-error' })
    await flush()
    expect(failed.host.querySelector('[role="alert"]')?.textContent).toContain('character unavailable')

    const aborted = deferred<Character>()
    getCharacter.mockReturnValueOnce(aborted.promise)
    const ignored = await mountSurface('character_card', { characterId: 'card-abort' })
    await reject(aborted, new DOMException('aborted', 'AbortError'))
    expect(ignored.host.querySelector('[role="alert"]')).toBeNull()
  })

  test('character_library_grid loads controlled summaries, selection, and JSON events', async () => {
    const pending = deferred<{ data: CharacterSummary[]; total: number }>()
    listSummaries.mockReturnValueOnce(pending.promise)
    const { host, handle } = await mountSurface('character_library_grid', {
      scope: 'shared',
      chatId: 'chat-1',
      filterTab: 'favorites',
      sortField: 'name',
      sortDirection: 'desc',
      viewMode: 'grid',
      search: 'query',
      excludeTags: ['blocked'],
      selectedCharacterId: 'grid-1',
    })
    const { events, off } = eventLog(handle)

    expect(host.querySelector('[role="status"]')).not.toBeNull()
    expect(listSummaries).toHaveBeenCalledWith(expect.objectContaining({
      limit: 100,
      offset: 0,
      scope: 'shared',
      chat_id: 'chat-1',
      filter: 'favorites',
      sort: 'name',
      direction: 'desc',
      search: 'query',
      exclude_tags: 'blocked',
    }), expect.any(AbortSignal))

    await settle(pending, { data: [browserSummary('grid-1', 'Grid character')], total: 1 })
    expect(host.querySelector('[data-testid="native-character-grid"]')?.getAttribute('data-selected-character-id')).toBe('grid-1')
    expect(gridPropsSeen.at(-1)?.characters).toEqual([expect.objectContaining({ id: 'grid-1' })])
    expect(gridPropsSeen.at(-1)?.batchSelected).toEqual(['grid-1'])
    expect(gridPropsSeen.at(-1)?.batchMode).toBe(false)

    await click(host.querySelector('[data-action="select"]')!)
    await click(host.querySelector('[data-action="open"]')!)
    expect(events.map(({ event }) => event)).toEqual(['select', 'open', 'select', 'open'])
    for (const { payload } of events) {
      expect(payload).toEqual({ characterId: 'grid-1' })
      expect(() => JSON.stringify(payload)).not.toThrow()
    }
    listSummaries.mockResolvedValueOnce({ data: [browserSummary('grid-2', 'Grid two')], total: 1 })
    handle.update({
      scope: 'mine',
      chatId: 'chat-2',
      filterTab: 'characters',
      sortField: 'recent',
      sortDirection: 'asc',
      viewMode: 'single',
      search: 'next',
      excludeTags: [],
      selectedCharacterId: 'grid-2',
    })
    await flush()
    expect(host.querySelector('[data-testid="native-character-grid"]')?.getAttribute('data-selected-character-id')).toBe('grid-2')
    for (const unsubscribe of off) unsubscribe()
  })
  test('character_library_grid uses explicit participant intersection and updates stale props', async () => {
    const first = browserSummary('participant-1', 'Participant one')
    const second = browserSummary('participant-2', 'Participant two')
    const mounted = await mountSurface('character_library_grid', {
      characters: [first, { id: 'invalid' }, second],
      selectedCharacterId: 'participant-1',
    })

    expect(listSummaries).not.toHaveBeenCalled()
    expect(mounted.host.querySelectorAll('[data-character-id]')).toHaveLength(2)
    expect(mounted.host.textContent).toContain('Participant one')
    expect(mounted.host.textContent).toContain('Participant two')
    expect(gridPropsSeen.at(-1)?.characters).toEqual([
      expect.objectContaining({ id: 'participant-1' }),
      expect.objectContaining({ id: 'participant-2' }),
    ])

    mounted.handle.update({
      characters: [browserSummary('participant-3', 'Participant three')],
      selectedCharacterId: 'participant-3',
    })
    await flush()
    expect(listSummaries).not.toHaveBeenCalled()
    expect(mounted.host.querySelector('[data-character-id="participant-1"]')).toBeNull()
    expect(mounted.host.querySelector('[data-character-id="participant-3"]')).not.toBeNull()
    expect(mounted.host.textContent).toContain('Participant three')
  })


  test('character_library_grid reports error, retry, empty, and abort states', async () => {
    listSummaries.mockRejectedValueOnce(new Error('grid unavailable'))
    const failed = await mountSurface('character_library_grid', { viewMode: 'grid' })
    await flush()
    expect(failed.host.querySelector('[role="alert"]')?.textContent).toContain('grid unavailable')
    const retry = failed.host.querySelector('button')!
    listSummaries.mockResolvedValueOnce({ data: [], total: 0 })
    await click(retry)
    await flush()
    expect(failed.host.querySelector('[data-state="empty"]')).not.toBeNull()

    listSummaries.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    const aborted = await mountSurface('character_library_grid', { viewMode: 'grid' })
    await flush()
    expect(aborted.host.querySelector('[role="alert"]')).toBeNull()
    expect(aborted.host.querySelector('[data-state="empty"]')).not.toBeNull()
  })

  test('character_preview_panel composes character and chat APIs without homepage preview', async () => {
    const characterPending = deferred<Character>()
    const chatsPending = deferred<Array<{ id: string; name: string; message_count: number; created_at: number; updated_at: number; last_message_preview: string }>>()
    getCharacter.mockReturnValueOnce(characterPending.promise)
    listCharacterChats.mockReturnValueOnce(chatsPending.promise)
    listWorldBooks.mockResolvedValueOnce({
      data: [
        { id: 'book-1', name: 'Primary world book' },
        { id: 'book-2', name: 'Secondary world book' },
        { id: 'book-unattached', name: 'Unattached world book' },
      ],
      total: 3,
    })
    const { host, handle } = await mountSurface('character_preview_panel', {
      characterId: 'preview-1',
      imageHeight: 280,
      pinned: false,
    })
    const { events, off } = eventLog(handle)

    expect(getCharacter).toHaveBeenCalledWith('preview-1')
    expect(listCharacterChats).toHaveBeenCalledWith('preview-1')
    expect(getHomepagePreview).not.toHaveBeenCalled()
    expect(host.querySelector('[role="status"]')).not.toBeNull()

    const previewCharacter = character('preview-1', 'Preview one')
    previewCharacter.extensions = { world_book_ids: ['book-1'] }
    await settle(characterPending, previewCharacter)
    await settle(chatsPending, [{
      id: 'chat-1',
      name: 'A chat',
      message_count: 3,
      created_at: 1,
      updated_at: 2,
      last_message_preview: 'Latest message '.repeat(30),
    }])

    expect(host.textContent).toContain('Preview one')
    const previewText = host.querySelector('[aria-labelledby="character-preview-chats"] li p')?.textContent ?? ''
    expect(previewText.length).toBeLessThanOrEqual(280)
    expect(host.textContent).toContain('Primary world book')
    expect(host.textContent).not.toContain('Unattached world book')
    expect(listWorldBooks).toHaveBeenCalledWith({ limit: 1000, offset: 0 })
    expect(listWorldBooks).toHaveBeenCalledTimes(1)

    const cachedCharacter = character('preview-2', 'Preview two')
    cachedCharacter.extensions = { world_book_ids: ['book-2'] }
    getCharacter.mockResolvedValueOnce(cachedCharacter)
    listCharacterChats.mockResolvedValueOnce([])
    const cached = await mountSurface('character_preview_panel', { characterId: 'preview-2' })
    await flush()
    expect(cached.host.textContent).toContain('Secondary world book')
    expect(listWorldBooks).toHaveBeenCalledTimes(1)

    for (const control of [
      host.querySelector<HTMLButtonElement>('[aria-label="Close preview"]'),
      host.querySelector<HTMLButtonElement>('[aria-label="Pin preview"]'),
      findButton(host, 'Edit character'),
      findButton(host, 'A chat'),
    ]) {
      if (control) await click(control)
    }
    expect(events.map(({ event }) => event)).toEqual(expect.arrayContaining(['close', 'pin', 'edit', 'openChat']))
    for (const { payload } of events) expect(() => JSON.stringify(payload)).not.toThrow()
    expect(getHomepagePreview).not.toHaveBeenCalled()
    expect(avatarUrl).toHaveBeenCalledWith('preview-1')
    for (const unsubscribe of off) unsubscribe()
  })

  test('character_preview_panel exposes loading, errors, abort handling, and unmount cleanup', async () => {
    const loading = deferred<Character>()
    const chats = deferred<Array<{ id: string; name: string; message_count: number; created_at: number; updated_at: number; last_message_preview: string }>>()
    getCharacter.mockReturnValueOnce(loading.promise)
    listCharacterChats.mockReturnValueOnce(chats.promise)
    const mounted = await mountSurface('character_preview_panel', { characterId: 'preview-loading' })
    expect(mounted.host.querySelector('[role="status"]')).not.toBeNull()
    mounted.handle.destroy()
    await settle(loading, character('preview-loading'))
    await settle(chats, [])
    expect(mounted.host.querySelector('[aria-label="Open chat"]')).toBeNull()

    getCharacter.mockRejectedValueOnce(new Error('preview failed'))
    listCharacterChats.mockResolvedValueOnce([])
    const failed = await mountSurface('character_preview_panel', { characterId: 'preview-error' })
    await flush()
    expect(failed.host.querySelector('[role="alert"]')?.textContent).toContain('preview failed')

    getCharacter.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    listCharacterChats.mockResolvedValueOnce([])
    const aborted = await mountSurface('character_preview_panel', { characterId: 'preview-abort' })
    await flush()
    expect(aborted.host.querySelector('[role="alert"]')).toBeNull()
    expect(getHomepagePreview).not.toHaveBeenCalled()
  })
})
