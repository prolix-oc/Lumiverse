import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import type { WorldBook, WorldBookEntry } from '@/types/api'

const noop = () => null
const invalidatedEntryIds: string[] = []
const invalidationSnapshots: Array<{ entryId: string; updateCalls: number; deleteCalls: number; bulkDeleteCalls: number }> = []
const tokenGenerations = new Map<string, number>()
const staleTokenCommits: string[] = []
const updateCalls: Array<{ bookId: string; entryId: string; input: Record<string, unknown> }> = []
const deleteCalls: Array<{ bookId: string; entryId: string; revision?: number }> = []
const bulkDeleteCalls: Array<{ bookId: string; input: Record<string, unknown> }> = []
const listEntryCalls: Array<{ bookId: string; limit: number; offset: number }> = []
const getEntryCalls: Array<{ bookId: string; entryId: string }> = []
const wsHandlers = new Map<string, (payload: unknown) => void>()
let listEntriesResult: { data: WorldBookEntry[]; total: number } = { data: [], total: 0 }
let updateDeferred: Deferred<WorldBookEntry> | null = null

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function beginTokenWork(entryId: string): Deferred<void> {
  const generation = tokenGenerations.get(entryId) ?? 0
  const deferred = createDeferred<void>()
  void deferred.promise.then(() => {
    if ((tokenGenerations.get(entryId) ?? 0) === generation) {
      staleTokenCommits.push(entryId)
    }
  }).catch(noop)
  return deferred
}

const storeState = {
  worldBookEntryViewPrefs: {},
  pendingWorldBookEditEntryId: null as string | null,
  setPendingWorldBookEditEntryId(value: string | null) {
    storeState.pendingWorldBookEditEntryId = value
  },
  setSetting() {},
}

const useStoreMock = <T,>(selector: (state: typeof storeState) => T): T => selector(storeState)
;(useStoreMock as typeof useStoreMock & { getState: () => typeof storeState }).getState = () => storeState

mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('@/hooks/useTokenCounts', () => ({
  useTokenCounts: () => ({ count: null, approximate: true, status: 'idle', requestCount: noop, cancel: noop }),
  useTokenCountSweep: noop,
  invalidateTokenCountsForEntry(entryId: string) {
    invalidatedEntryIds.push(entryId)
    invalidationSnapshots.push({
      entryId,
      updateCalls: updateCalls.length,
      deleteCalls: deleteCalls.length,
      bulkDeleteCalls: bulkDeleteCalls.length,
    })
    tokenGenerations.set(entryId, (tokenGenerations.get(entryId) ?? 0) + 1)
  },
}))
mock.module('@/api/world-books', () => ({
  worldBooksApi: {
    listEntries: async (bookId: string, input: { limit: number; offset: number }) => {
      listEntryCalls.push({ bookId, limit: input.limit, offset: input.offset })
      return {
        ...listEntriesResult,
        data: listEntriesResult.data.slice(input.offset, input.offset + input.limit),
      }
    },
    getEntry: async (bookId: string, entryId: string) => {
      getEntryCalls.push({ bookId, entryId })
      const found = listEntriesResult.data.find((candidate) => candidate.id === entryId)
      if (!found) throw new Error(`missing fixture entry ${entryId}`)
      return found
    },
    updateEntry(bookId: string, entryId: string, input: Record<string, unknown>) {
      updateCalls.push({ bookId, entryId, input })
      if (!updateDeferred) throw new Error('missing update deferred')
      return updateDeferred.promise
    },
    deleteEntry: async (bookId: string, entryId: string, revision?: number) => {
      deleteCalls.push({ bookId, entryId, revision })
    },
    bulkEntryAction: async (bookId: string, input: Record<string, unknown>) => {
      bulkDeleteCalls.push({ bookId, input })
      return { success: true }
    },
    createEntry: async () => { throw new Error('unexpected create') },
    duplicateEntry: async () => { throw new Error('unexpected duplicate') },
    reorderEntries: async () => ({ success: true }),
  },
}))
mock.module('@/ws/events', () => ({
  EventType: {
    WORLD_BOOK_CHANGED: 'world-book-changed',
    WORLD_BOOK_ENTRY_CHANGED: 'world-book-entry-changed',
    WORLD_BOOK_ENTRY_DELETED: 'world-book-entry-deleted',
  },
}))
mock.module('@/ws/client', () => ({
  wsClient: {
    on(event: string, handler: (payload: unknown) => void) {
      wsHandlers.set(event, handler)
      return () => wsHandlers.delete(event)
    },
  },
}))
mock.module('@/lib/i18n/worldBookEntryLabels', () => ({
  useWorldBookEntryLabels: () => ({
    entryTypeLabel: () => 'trigger',
    positionLabel: () => 'position',
    sortOptions: [{ value: 'custom', label: 'custom' }],
    pageSizeOptions: [{ value: 50, label: '50' }],
    typeOptions: [],
    positionOptions: [],
  }),
}))
mock.module('@/lib/i18n/loomOptionLabels', () => ({ useLoomOptionLabels: () => ({ markerLabel: () => 'marker' }) }))
mock.module('@/lib/dndUiScale', () => ({ useScaledSortableStyle: (input: unknown) => input }))
mock.module('@/hooks/useScrollGate', () => ({ useScrollGate: noop }))
mock.module('@/hooks/useIsMobile', () => ({ default: () => false }))
mock.module('@/components/shared/WorldBookEntryEditor', () => ({
  default: ({ entry, onUpdate }: { entry: WorldBookEntry; onUpdate(entryId: string, updates: Record<string, unknown>): void }) => (
    <button type="button" data-testid={`edit-${entry.id}`} onClick={() => onUpdate(entry.id, { content: 'optimistic content' })}>
      edit
    </button>
  ),
}))
mock.module('@/components/panels/world-book/WorldBookTokenReportModal', () => ({ default: noop }))
mock.module('@/components/shared/ConfirmationModal', () => ({
  default: ({ onConfirm }: { onConfirm(): Promise<void> }) => <button type="button" data-testid="confirm-delete" onClick={() => void onConfirm()}>confirm</button>,
}))
mock.module('@/components/shared/ContextMenu', () => ({
  default: ({ items }: { items: Array<{ key: string; onClick?(): void }> }) => (
    <>{items.map((item) => item.onClick && <button key={item.key} type="button" data-testid={`menu-${item.key}`} onClick={item.onClick}>{item.key}</button>)}</>
  ),
}))
mock.module('@/components/shared/ModalPresentation', () => ({ ModalPresentation: ({ children }: { children?: ReactNode }) => <>{children}</> }))
mock.module('@/components/shared/SearchableSelect', () => ({ default: noop }))
mock.module('@/components/shared/FormComponents', () => ({ FormField: noop, Select: noop, TextInput: noop, Button: noop }))
mock.module('@/components/shared/Pagination', () => ({ default: noop }))
mock.module('@/store', () => ({ useStore: useStoreMock }))
mock.module('@/lib/clearableSearch', () => ({ clearSearchOnEscape: noop }))
mock.module('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { children?: ReactNode }) => <>{children}</>,
  MouseSensor: class {}, TouchSensor: class {}, KeyboardSensor: class {},
  closestCenter: noop, useSensor: noop, useSensors: () => [],
}))
mock.module('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children?: ReactNode }) => <>{children}</>,
  arrayMove: <T,>(items: T[]) => items, sortableKeyboardCoordinates: noop,
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: noop, transform: null, transition: null, isDragging: false }),
  verticalListSortingStrategy: noop,
}))
mock.module('lucide-react', () => ({
  ArrowDown: noop, ArrowUp: noop, ArrowUpDown: noop, CheckSquare: noop,
  ChevronDown: noop, ChevronRight: noop, Copy: noop, FileText: noop, GripVertical: noop,
  Hash: noop, MoreVertical: noop, MoveRight: noop, Plus: noop, Plug: noop,
  Search: noop, Square: noop, Tag: noop, Trash2: noop, X: noop,
  ArrowBigUp: noop, ArrowBigDown: noop, BetweenHorizontalStart: noop,
  BetweenHorizontalEnd: noop, Lock: noop, MapPin: noop, Zap: noop,
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window], ['document', globalObject.document], ['navigator', globalObject.navigator],
  ['Node', globalObject.Node], ['Element', globalObject.Element], ['HTMLElement', globalObject.HTMLElement],
  ['HTMLInputElement', globalObject.HTMLInputElement], ['HTMLTextAreaElement', globalObject.HTMLTextAreaElement],
  ['HTMLSelectElement', globalObject.HTMLSelectElement], ['SVGElement', globalObject.SVGElement],
  ['CSS', globalObject.CSS], ['IS_REACT_ACT_ENVIRONMENT', globalObject.IS_REACT_ACT_ENVIRONMENT],
])
Object.assign(globalObject, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  HTMLSelectElement: dom.window.HTMLSelectElement, SVGElement: dom.window.SVGElement,
  CSS: { escape: (value: string) => value }, IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: noop,
})

const { default: WorldBookEntriesSection } = await import('./WorldBookEntriesSection')

const book: WorldBook = { id: 'book-1', name: 'Book', description: '', folder: '', metadata: {}, created_at: 0, updated_at: 0 }

function entry(id: string, content = 'original content'): WorldBookEntry {
  return {
    id, world_book_id: book.id, uid: id, outlet_name: null, wi_marker: null, wi_marker_side: null,
    key: [], keysecondary: [], content, comment: id, position: 0, depth: 4, role: null, order_value: 0,
    selective: false, constant: false, disabled: false, group_name: '', group_override: false, group_weight: 100,
    probability: 100, scan_depth: null, case_sensitive: false, match_whole_words: false, automation_id: null,
    use_regex: false, prevent_recursion: false, exclude_recursion: false, delay_until_recursion: false,
    priority: 0, sticky: 0, cooldown: 0, delay: 0, selective_logic: 0, use_probability: false,
    vectorized: false, vector_index_status: 'not_enabled', vector_indexed_at: null, vector_index_error: null,
    revision: 7, extensions: {}, created_at: 0, updated_at: 0,
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms))
    await flush()
  })
}

async function render(entries: WorldBookEntry[]): Promise<{ root: Root; host: HTMLDivElement }> {
  listEntriesResult = { data: entries, total: entries.length }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(WorldBookEntriesSection, { books: [book], selectedBookId: book.id }))
    await flush()
  })
  await wait(225)
  return { root, host }
}

function click(host: HTMLElement, selector: string): void {
  const element = host.querySelector<HTMLButtonElement>(selector)
  if (!element) throw new Error(`missing ${selector}`)
  act(() => element.click())
}

function clickByText(host: HTMLElement, text: string): void {
  const element = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes(text))
  if (!element) throw new Error(`missing button containing ${text}`)
  act(() => element.click())
}

function unmount(root: Root): void {
  act(() => root.unmount())
}

afterEach(() => {
  invalidatedEntryIds.length = 0
  invalidationSnapshots.length = 0
  tokenGenerations.clear()
  staleTokenCommits.length = 0
  updateCalls.length = 0
  deleteCalls.length = 0
  bulkDeleteCalls.length = 0
  listEntryCalls.length = 0
  getEntryCalls.length = 0
  wsHandlers.clear()
  updateDeferred = null
  listEntriesResult = { data: [], total: 0 }
  storeState.pendingWorldBookEditEntryId = null
  document.body.replaceChildren()
})

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('WorldBookEntriesSection token-count invalidation', () => {
  test('opens a pending deep-linked entry outside the current server page', async () => {
    const entries = Array.from({ length: 75 }, (_, index) => entry(`entry-${String(index + 1).padStart(2, '0')}`))
    storeState.pendingWorldBookEditEntryId = 'entry-60'
    const { root, host } = await render(entries)
    try {
      expect(storeState.pendingWorldBookEditEntryId).toBeNull()
      expect(host.querySelector('[data-entry-id="entry-60"]')).not.toBeNull()
      expect(host.querySelector('[data-entry-id="entry-01"]')).not.toBeNull()
      expect(host.querySelector('[data-entry-id="entry-51"]')).toBeNull()
      expect(listEntryCalls).toContainEqual({ bookId: book.id, limit: 50, offset: 0 })
      expect(getEntryCalls).toContainEqual({ bookId: book.id, entryId: 'entry-60' })
    } finally {
      unmount(root)
    }
  })

  test('renders stable row and token-cell anchors with an immediate estimate', async () => {
    const { root, host } = await render([entry('entry-anchor', '12345678')])
    try {
      const row = host.querySelector('[data-world-book-entry-row="entry-anchor"]')
      const tokenCell = row?.querySelector('[data-world-book-token-cell="true"]')
      expect(row).not.toBeNull()
      expect(row?.getAttribute('data-world-book-entry-revision')).toBe('7')
      expect(row?.closest('[data-world-book-entries-book-id]')?.getAttribute('data-world-book-entries-book-id')).toBe(book.id)
      expect(tokenCell?.textContent).toBe('~2')
    } finally {
      unmount(root)
    }
  })

  test('invalidates before optimistic content save and server replacement without awaiting token work', async () => {
    const original = entry('entry-1')
    const serverReplacement = entry('entry-1', 'server-normalized content')
    serverReplacement.comment = 'server replacement'
    updateDeferred = createDeferred<WorldBookEntry>()
    const staleTokenWork = beginTokenWork('entry-1')
    const { root, host } = await render([original])
    try {
      click(host, '[data-entry-id="entry-1"] button[title*="expandEditor"]')
      click(host, '[data-testid="edit-entry-1"]')

      expect(invalidatedEntryIds).toEqual(['entry-1'])
      expect(invalidationSnapshots).toEqual([
        { entryId: 'entry-1', updateCalls: 0, deleteCalls: 0, bulkDeleteCalls: 0 },
      ])
      expect(updateCalls).toHaveLength(0)


      await wait(425)
      expect(updateCalls).toEqual([{
        bookId: book.id,
        entryId: 'entry-1',
        input: { content: 'optimistic content', expected_revision: 7 },
      }])

      await act(async () => {
        staleTokenWork.resolve()
        await flush()
      })
      expect(staleTokenCommits).toEqual([])

      await act(async () => {
        updateDeferred?.resolve(serverReplacement)
        await flush()
      })
      expect(invalidatedEntryIds).toEqual(['entry-1', 'entry-1'])
      expect(invalidationSnapshots).toEqual([
        { entryId: 'entry-1', updateCalls: 0, deleteCalls: 0, bulkDeleteCalls: 0 },
        { entryId: 'entry-1', updateCalls: 1, deleteCalls: 0, bulkDeleteCalls: 0 },
      ])
      expect(host.textContent).toContain('server replacement')
    } finally {
      unmount(root)
    }
  })

  test('invalidates accepted visible and non-visible WebSocket change and delete events', async () => {
    const visible = entry('entry-visible')
    const { root } = await render([visible])
    try {
      await act(async () => {
        wsHandlers.get('world-book-entry-changed')?.({ id: 'entry-visible', worldBookId: book.id, entry: entry('entry-visible', 'external') })
        wsHandlers.get('world-book-entry-changed')?.({ id: 'entry-off-page', worldBookId: book.id, entry: entry('entry-off-page', 'external') })
        wsHandlers.get('world-book-entry-deleted')?.({ id: 'entry-visible', worldBookId: book.id })
        wsHandlers.get('world-book-entry-deleted')?.({ id: 'entry-off-page', worldBookId: book.id })
        await flush()
      })

      expect(invalidatedEntryIds).toEqual(['entry-visible', 'entry-off-page', 'entry-visible', 'entry-off-page'])
      expect(invalidationSnapshots).toEqual([
        { entryId: 'entry-visible', updateCalls: 0, deleteCalls: 0, bulkDeleteCalls: 0 },
        { entryId: 'entry-off-page', updateCalls: 0, deleteCalls: 0, bulkDeleteCalls: 0 },
        { entryId: 'entry-visible', updateCalls: 0, deleteCalls: 0, bulkDeleteCalls: 0 },
        { entryId: 'entry-off-page', updateCalls: 0, deleteCalls: 0, bulkDeleteCalls: 0 },
      ])
    } finally {
      unmount(root)
    }
  })

  test('invalidates single and bulk local deletes before their API calls', async () => {
    const first = entry('entry-1')
    const second = entry('entry-2')
    const staleTokenWork = beginTokenWork('entry-1')
    const { root, host } = await render([first, second])
    try {
      click(host, '[data-entry-id="entry-1"] button[title*="moreActions"]')
      click(host, '[data-testid="menu-delete"]')
      click(host, '[data-testid="confirm-delete"]')
      await wait(0)
      staleTokenWork.resolve()
      await flush()

      expect(invalidatedEntryIds).toEqual(['entry-1'])
      expect(invalidationSnapshots[0]).toEqual({ entryId: 'entry-1', updateCalls: 0, deleteCalls: 0, bulkDeleteCalls: 0 })
      expect(deleteCalls).toEqual([{ bookId: book.id, entryId: 'entry-1', revision: 7 }])
      expect(staleTokenCommits).toEqual([])

      click(host, 'button[title*="bulkSelect"]')
      const toggles = host.querySelectorAll<HTMLInputElement>('input[aria-label*="selectEntry"]')
      act(() => {
        toggles[0]?.click()
        toggles[1]?.click()
      })
      clickByText(host, 'actions.delete')
      click(host, '[data-testid="confirm-delete"]')
      await wait(0)

      expect(invalidatedEntryIds).toEqual(['entry-1', 'entry-1', 'entry-2'])
      expect(invalidationSnapshots.slice(-2)).toEqual([
        { entryId: 'entry-1', updateCalls: 0, deleteCalls: 1, bulkDeleteCalls: 0 },
        { entryId: 'entry-2', updateCalls: 0, deleteCalls: 1, bulkDeleteCalls: 0 },
      ])
      expect(bulkDeleteCalls).toEqual([{
        bookId: book.id,
        input: { action: 'delete', entry_ids: ['entry-1', 'entry-2'], expected_revisions: { 'entry-1': 7, 'entry-2': 7 } },
      }])
    } finally {
      unmount(root)
    }
  })
})
