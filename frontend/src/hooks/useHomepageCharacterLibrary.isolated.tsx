import { afterAll, afterEach, describe, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

const listSummaries = jest.fn()
const listTags = jest.fn(async () => [])
const getHomepagePreview = jest.fn(async () => null)
const getCharacter = jest.fn()
const navigate = jest.fn()
const setSetting = jest.fn()
const setEditingCharacterId = jest.fn()
const updateCharacter = jest.fn()
const openSettings = jest.fn()

const homepageSettings = {
  enabled: true,
  thumbnailWidth: 220,
  thumbnailHeight: 280,
  density: 'balanced',
  footerMode: 'balanced',
  visibleMetadata: ['creator', 'tags'],
  tagRows: 1,
  viewMode: 'grid',
  defaultSort: 'recent',
  defaultFilter: 'characters',
  maxVisibleTags: 6,
  showNameBackground: false,
  panelWidth: 420,
  panelImageHeight: 320,
  panelPinned: false,
  lastSelectedCharacterId: null,
}

const storeState = {
  homepageCharacterLibrarySettings: homepageSettings,
  characterTabDisplaySettings: { ...homepageSettings, useHomepageSettings: true },
  favorites: [] as string[],
  activeChatId: null,
  setSetting,
  setEditingCharacterId,
  updateCharacter,
  openSettings,
}

const useStore = <T,>(selector: (state: typeof storeState) => T): T => selector(storeState)
const handlers = new Map<string, Set<(payload: unknown) => void>>()
const unsubscribeEvents: string[] = []
const wsOn = jest.fn((event: string, handler: (payload: unknown) => void) => {
  const listeners = handlers.get(event) ?? new Set<(payload: unknown) => void>()
  listeners.add(handler)
  handlers.set(event, listeners)
  return () => {
    unsubscribeEvents.push(event)
    listeners.delete(handler)
  }
})

mock.module('@/store', () => ({ useStore }))
mock.module('react-router', () => ({ useNavigate: () => navigate }))
mock.module('@/api/characters', () => ({
  charactersApi: { listSummaries, listTags, getHomepagePreview, get: getCharacter },
}))
mock.module('@/api/chats', () => ({ chatsApi: { create: jest.fn() } }))
mock.module('@/ws/client', () => ({ wsClient: { on: wsOn } }))

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['navigator', globalObject.navigator],
  ['Node', globalObject.Node],
  ['HTMLElement', globalObject.HTMLElement],
  ['DOMException', globalObject.DOMException],
  ['IS_REACT_ACT_ENVIRONMENT', globalObject.IS_REACT_ACT_ENVIRONMENT],
])
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  DOMException: dom.window.DOMException,
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })

const { EventType } = await import('@/ws/events')
const { useHomepageCharacterLibrary } = await import('./useHomepageCharacterLibrary')
const { createRoot } = await import('react-dom/client')
mock.restore()

type HookSurface = ReturnType<typeof useHomepageCharacterLibrary>
let hookSurface: HookSurface
let mountedRoot: Root | null = null

function summary(index: number) {
  return {
    id: `character-${index}`,
    library_scope: 'mine' as const,
    name: `Character ${index}`,
    creator: '',
    folder: '',
    tags: [],
    image_id: null,
    created_at: index,
    updated_at: index,
    has_alternate_greetings: false,
  }
}

const firstPage = Array.from({ length: 80 }, (_, index) => summary(index))
const secondPage = Array.from({ length: 80 }, (_, index) => summary(index + 80))

/* eslint-disable react-compiler/react-compiler */
function HookHarness() {
  hookSurface = useHomepageCharacterLibrary()
  return null
}
/* eslint-enable react-compiler/react-compiler */

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

function dispatch(event: string): void {
  for (const handler of handlers.get(event) ?? []) handler({})
}

afterEach(async () => {
  if (mountedRoot) {
    await act(async () => {
      mountedRoot?.unmount()
      await flush()
    })
    mountedRoot = null
  }
  document.body.replaceChildren()
  handlers.clear()
  unsubscribeEvents.length = 0
  wsOn.mockClear()
  listSummaries.mockReset()
  listTags.mockClear()
  getHomepagePreview.mockClear()
  getCharacter.mockReset()
  navigate.mockClear()
  setEditingCharacterId.mockClear()
  updateCharacter.mockClear()
  openSettings.mockClear()
})

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
})

describe('useHomepageCharacterLibrary websocket invalidation', () => {
  test('refetches page one for activity events and unsubscribes on unmount', async () => {
    listSummaries.mockImplementation(async (params: { offset?: number }) => ({
      data: params.offset === 80 ? secondPage : firstPage,
      total: 160,
      limit: 80,
      offset: params.offset ?? 0,
    }))

    const host = document.createElement('div')
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => {
      mountedRoot?.render(createElement(HookHarness))
      await flush()
    })

    expect(listSummaries).toHaveBeenCalledTimes(1)
    expect(listSummaries.mock.calls[0]?.[0]).toMatchObject({ offset: 0, sort: 'recent' })

    await act(async () => {
      hookSurface.loadMore()
      await flush()
    })
    expect(listSummaries.mock.calls.at(-1)?.[0]).toMatchObject({ offset: 80, sort: 'recent' })

    const activityEvents = [
      EventType.MESSAGE_SENT,
      EventType.CHAT_CREATED,
      EventType.CHAT_CHANGED,
      EventType.CHAT_DELETED,
      EventType.CHAT_FORKED,
      EventType.CHARACTER_CREATED,
      EventType.CHARACTER_EDITED,
      EventType.CHARACTER_DELETED,
      EventType.CHARACTER_LIBRARY_CHANGED,
    ]

    for (const event of activityEvents) {
      const callsBefore = listSummaries.mock.calls.length
      await act(async () => {
        dispatch(event)
        await flush()
      })
      expect(listSummaries).toHaveBeenCalledTimes(callsBefore + 1)
      expect(listSummaries.mock.calls.at(-1)?.[0]).toMatchObject({ offset: 0, sort: 'recent' })
    }

    await act(async () => {
      mountedRoot?.unmount()
      await flush()
    })
    mountedRoot = null

    expect(unsubscribeEvents.sort()).toEqual(activityEvents.map(String).sort())
    expect([...handlers.values()].every((listeners) => listeners.size === 0)).toBe(true)
  })
})

describe('useHomepageCharacterLibrary actions', () => {
  test('loads the full character into the store before opening the global editor without navigating', async () => {
    listSummaries.mockResolvedValue({ data: [], total: 0, limit: 80, offset: 0 })
    const character = { id: 'character-1', name: 'Iris' }
    getCharacter.mockResolvedValue(character)

    const host = document.createElement('div')
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => {
      mountedRoot?.render(createElement(HookHarness))
      await flush()
    })

    await act(async () => {
      await hookSurface.editCharacter(character.id)
    })

    expect(getCharacter).toHaveBeenCalledWith(character.id)
    expect(updateCharacter).toHaveBeenCalledWith(character.id, character)
    expect(setEditingCharacterId).toHaveBeenCalledWith(character.id)
    expect(navigate).not.toHaveBeenCalled()
  })

  test('ignores a stale edit response when a newer character finishes loading first', async () => {
    listSummaries.mockResolvedValue({ data: [], total: 0, limit: 80, offset: 0 })
    let resolveFirst!: (character: { id: string; name: string }) => void
    let resolveSecond!: (character: { id: string; name: string }) => void
    getCharacter.mockImplementation((id: string) => new Promise((resolve) => {
      if (id === 'character-1') resolveFirst = resolve
      else resolveSecond = resolve
    }))

    const host = document.createElement('div')
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => {
      mountedRoot?.render(createElement(HookHarness))
      await flush()
    })

    let firstEdit!: Promise<void>
    let secondEdit!: Promise<void>
    await act(async () => {
      firstEdit = hookSurface.editCharacter('character-1')
      secondEdit = hookSurface.editCharacter('character-2')
      await flush()
    })
    await act(async () => {
      resolveSecond({ id: 'character-2', name: 'Second' })
      await secondEdit
      resolveFirst({ id: 'character-1', name: 'First' })
      await firstEdit
    })

    expect(updateCharacter).toHaveBeenCalledTimes(1)
    expect(updateCharacter).toHaveBeenCalledWith('character-2', { id: 'character-2', name: 'Second' })
    expect(setEditingCharacterId).toHaveBeenCalledTimes(1)
    expect(setEditingCharacterId).toHaveBeenCalledWith('character-2')
  })

  test('surfaces the active edit request failure without opening the editor', async () => {
    listSummaries.mockResolvedValue({ data: [], total: 0, limit: 80, offset: 0 })
    getCharacter.mockRejectedValue(new Error('Unable to load character'))

    const host = document.createElement('div')
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => {
      mountedRoot?.render(createElement(HookHarness))
      await new Promise((resolve) => setTimeout(resolve, 0))
      await flush()
    })
    await act(async () => {
      await hookSurface.editCharacter('character-1')
      await flush()
    })

    expect(hookSurface.error).toBe('Unable to load character')
    expect(updateCharacter).not.toHaveBeenCalled()
    expect(setEditingCharacterId).not.toHaveBeenCalled()
  })

  test('opens productivity settings at the homepage character library section', async () => {
    listSummaries.mockResolvedValue({ data: [], total: 0, limit: 80, offset: 0 })
    const host = document.createElement('div')
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => {
      mountedRoot?.render(createElement(HookHarness))
      await flush()
    })

    await act(async () => {
      hookSurface.openSettings()
    })

    expect(openSettings).toHaveBeenCalledWith('productivity', { anchorId: 'homepage-character-library-settings' })
  })
})
