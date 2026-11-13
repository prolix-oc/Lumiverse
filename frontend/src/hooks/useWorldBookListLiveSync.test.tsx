import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act, useLayoutEffect } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { WorldBook } from '@/types/api'
import type { useWorldBookListLiveSync as UseLiveSync } from './useWorldBookListLiveSync'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const handlers = new Map<string, Set<(payload?: unknown) => void>>()
const subscriptions = new Map<string, number>()
const imported = new Set<() => void>()
mock.module('@/ws/client', () => ({
  WS_OPEN: 'open',
  wsClient: { on: (type: string, callback: (payload?: unknown) => void) => {
    subscriptions.set(type, (subscriptions.get(type) ?? 0) + 1)
    if (!handlers.has(type)) handlers.set(type, new Set())
    handlers.get(type)!.add(callback)
    return () => { handlers.get(type)!.delete(callback) }
  } },
}))
mock.module('@/lib/import-data-events', () => ({ subscribeImportedDataRefresh: (callback: () => void) => {
  imported.add(callback)
  return () => { imported.delete(callback) }
} }))

let useLiveSync: typeof UseLiveSync
let root: Root
let host: HTMLDivElement
let options: Parameters<typeof UseLiveSync>[0]
let markLocalBookEdit: () => void
let books: WorldBook[]
let deleted: string[]
let refreshed: string[]
const book = (id: string, name = id) => ({ id, name } as WorldBook)

beforeAll(async () => { useLiveSync = (await import('./useWorldBookListLiveSync')).useWorldBookListLiveSync })
afterEach(() => {
  if (root) act(() => root.unmount())
  host?.remove()
  handlers.clear()
  subscriptions.clear()
  imported.clear()
})
afterAll(() => dom.window.close())

function Probe() {
  const sync = useLiveSync(options)
  useLayoutEffect(() => { markLocalBookEdit = sync.markLocalBookEdit }, [sync.markLocalBookEdit])
  return null
}
async function mount() {
  books = [book('a'), book('b')]
  deleted = []
  refreshed = []
  options = {
    selectedBookId: 'a',
    setBooks: (update) => { books = typeof update === 'function' ? update(books) : update },
    onSelectedBookDeleted: () => deleted.push('old'),
  }
  host = document.createElement('div')
  document.body.append(host)
  root = (await import('react-dom/client')).createRoot(host)
  act(() => root.render(<Probe />))
}
function emit(type: string, payload?: unknown) {
  act(() => { handlers.get(type)?.forEach((callback) => callback(payload)) })
}

test('reads the committed selection and callbacks without reconnecting subscriptions', async () => {
  await mount()
  const initialSubscriptions = new Map(subscriptions)
  let setterCalls = 0
  options = {
    ...options, selectedBookId: 'b',
    setBooks: (update) => {
      setterCalls++
      books = typeof update === 'function' ? update(books) : update
    },
    onSelectedBookDeleted: () => deleted.push('new'),
    refreshBooks: () => { refreshed.push('new') },
  }
  act(() => root.render(<Probe />))
  const { EventType } = await import('@/ws/events')
  emit(EventType.WORLD_BOOK_CHANGED, { id: 'a', worldBook: book('a', 'updated') })
  emit(EventType.WORLD_BOOK_DELETED, { id: 'b' })
  emit(EventType.WORLD_BOOK_LIBRARY_CHANGED)
  emit('open')
  act(() => { imported.forEach((callback) => callback()) })
  expect(books).toEqual([book('a', 'updated')])
  expect(setterCalls).toBe(2)
  expect(deleted).toEqual(['new'])
  expect(refreshed).toEqual(['new', 'new', 'new'])
  expect(subscriptions).toEqual(initialSubscriptions)

  options = { ...options, refreshBooks: undefined }
  act(() => root.render(<Probe />))
  emit('open')
  expect(refreshed).toHaveLength(3)
})

test('protects local edits only for the current selection and cleans up every listener', async () => {
  await mount()
  const { EventType } = await import('@/ws/events')
  act(() => markLocalBookEdit())
  emit(EventType.WORLD_BOOK_CHANGED, { id: 'a', worldBook: book('a', 'echo') })
  emit(EventType.WORLD_BOOK_CHANGED, { id: 'b', worldBook: book('b', 'remote') })
  expect(books).toEqual([book('a'), book('b', 'remote')])
  options = { ...options, selectedBookId: 'b' }
  act(() => root.render(<Probe />))
  emit(EventType.WORLD_BOOK_CHANGED, { id: 'a', worldBook: book('a', 'remote') })
  expect(books[0].name).toBe('remote')
  act(() => root.unmount())
  expect([...handlers.values()].every((callbacks) => callbacks.size === 0)).toBe(true)
  expect(imported.size).toBe(0)
})
