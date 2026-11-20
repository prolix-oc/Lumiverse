/**
 * Workspace-level coverage for the bulk Apply bar's async outcomes: stale
 * "Saved" clearing, a definite rejection, a conflict on a row that is not in
 * the inspector, an acknowledged write whose refresh failed, a write whose
 * outcome is unknown, a clean success, and the shared Duplicate/Delete path.
 *
 * This suite installs process-wide Bun module mocks, so run it with
 * `bun test --isolate`, like the other DOM suites in this package.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type {
  WorldBook,
  WorldBookEntry,
  WorldBookEntryBulkActionInput,
  WorldBookEntryConflictPayload,
} from '@/types/api'

/** Mirrors ApiError closely enough for the workspace's `instanceof` checks. */
class MockApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body?: unknown,
  ) {
    super(`${status} ${statusText}`)
    this.name = 'ApiError'
  }
}

// `pretendToBeVisual` is what gives jsdom a `requestAnimationFrame`, which the
// entry table's virtualizer needs on mount.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
const previousGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['HTMLElement', globalObject.HTMLElement],
  ['Element', globalObject.Element],
  ['Node', globalObject.Node],
  ['navigator', globalObject.navigator],
  ['getComputedStyle', globalObject.getComputedStyle],
])
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  // `EntryTable` reads the UI font scale through `getComputedStyle` on mount.
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: FakeResizeObserver })
Object.assign(dom.window, { ResizeObserver: FakeResizeObserver })

/**
 * jsdom performs no layout: every box is 0x0, so the virtualizer would compute a
 * zero-height viewport and render no rows at all. Give the scroll region a real
 * height and each measured row a real pitch, which is the only geometry this
 * suite needs to reach a mounted row.
 */
const TEST_VIEWPORT_HEIGHT = 900
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get() {
    const element = this as HTMLElement
    return element.classList.contains('entryScrollList') ? TEST_VIEWPORT_HEIGHT : 32
  },
})
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get() { return 960 },
})
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get() {
    const element = this as HTMLElement
    if (element.classList.contains('entryScrollList')) return TEST_VIEWPORT_HEIGHT
    return 32
  },
})
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() { return 960 },
})
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetTop', {
  configurable: true,
  get() { return 0 },
})
// jsdom implements no scrolling; the selected-row reveal calls this unconditionally.
dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {}

const cssProxy = new Proxy({}, { get: (_target, key) => String(key) })
mock.module('./LorebookEditorLayout.module.css', () => ({ default: cssProxy }))

const toasts: Array<{ type: string; message: string }> = []
const storeState = {
  addToast: (toast: { type: string; message: string }) => {
    toasts.push(toast)
    return `toast-${toasts.length}`
  },
}
const useStore = Object.assign(
  (selector: (state: typeof storeState) => unknown) => selector(storeState),
  { getState: () => storeState },
)

const entry = (id: string, overrides: Partial<WorldBookEntry> = {}): WorldBookEntry => ({
  folder: '', tags: [],
  id,
  world_book_id: 'book-1',
  uid: id,
  outlet_name: null,
  wi_marker: null,
  wi_marker_side: null,
  key: [],
  keysecondary: [],
  content: `${id} content`,
  comment: id,
  position: 0,
  depth: 4,
  role: null,
  order_value: 100,
  selective: false,
  constant: false,
  disabled: false,
  group_name: '',
  group_override: false,
  group_weight: 100,
  probability: 100,
  scan_depth: null,
  case_sensitive: false,
  match_whole_words: false,
  automation_id: null,
  use_regex: false,
  prevent_recursion: false,
  exclude_recursion: false,
  delay_until_recursion: false,
  priority: 10,
  sticky: 0,
  cooldown: 0,
  delay: 0,
  selective_logic: 0,
  use_probability: true,
  vectorized: false,
  vector_index_status: 'not_enabled',
  vector_indexed_at: null,
  vector_index_error: null,
  revision: 1,
  extensions: {},
  created_at: 1,
  updated_at: 1,
  ...overrides,
})

const state = {
  books: [{
    id: 'book-1',
    name: 'Book One',
    description: '',
    folder: '',
    metadata: {},
    created_at: 1,
    updated_at: 1,
  }] as WorldBook[],
  entries: [] as WorldBookEntry[],
  bulkCalls: [] as Array<{ bookId: string; input: WorldBookEntryBulkActionInput }>,
  entryListCalls: 0,
  lastEntryListBookId: null as string | null,
  bulkError: null as Error | null,
  failNextEntryList: false,
  entryListHandler: null as null | ((bookId: string, options?: { signal?: AbortSignal }) => Promise<WorldBookEntry[]>),
}

mock.module('@/store', () => ({ useStore }))

// The workspace mirrors the API error shape with `instanceof ApiError`, so the
// mock and the thrown errors must come from the same class.
mock.module('@/api/client', () => ({ ApiError: MockApiError, BASE_URL: '/api/v1' }))

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

mock.module('@/ws/client', () => ({ wsClient: { on: () => () => undefined } }))
mock.module('@/ws/events', () => ({ EventType: { WORLD_BOOK_LIBRARY_CHANGED: 'world_book_library_changed' } }))

mock.module('@/api/world-books', () => ({
  worldBooksApi: {
    list: async () => ({ data: state.books, total: state.books.length, limit: 1000, offset: 0 }),
    // The real `listAllEntries` walks pages through the shared `get` helper, so a
    // mock that returns a bare array never terminates its loop. This mirrors the
    // same page-walking contract the API module implements.
    listAllEntries: async (bookId: string, options?: { signal?: AbortSignal }) => {
      state.entryListCalls += 1
      state.lastEntryListBookId = bookId
      if (state.failNextEntryList) {
        state.failNextEntryList = false
        throw new Error('entries unavailable')
      }
      if (state.entryListHandler) return state.entryListHandler(bookId, options)
      return state.entries.map((item) => ({ ...item }))
    },
    bulkEntryAction: async (bookId: string, input: WorldBookEntryBulkActionInput) => {
      state.bulkCalls.push({ bookId, input })
      const error = state.bulkError
      state.bulkError = null
      if (error) throw error
      return { action: input.action, affected: input.entry_ids.length }
    },
    updateEntry: async () => { throw new Error('row saves are out of scope for the bulk suite') },
    reorderEntries: async () => ({ success: true, count: 0 }),
    create: async () => state.books[0]!,
    createEntry: async () => state.entries[0]!,
  },
}))

mock.module('./useLorebookTokenCounts', () => ({
  useLorebookTokenCounts: () => ({
    resolveTokenCount: () => ({ value: 0, exact: false }),
    handleEntryPointerEnter: () => undefined,
    handleEntryPointerLeave: () => undefined,
  }),
}))

mock.module('./useLorebookEditorLayoutSettings', () => ({
  useLorebookEditorLayoutSettings: () => ({
    settings: {
      defaultVariant: 'full',
      triggerDisplay: 'words',
      halfButtonEnabled: false,
      loreIndicatorActionEnabled: false,
      allowSimultaneousEditors: false,
      halfEditorMode: 'docked',
      fullRect: {},
      halfRect: {},
      minChatWidth: 0,
      minEditorPaneWidth: 0,
      halfEntriesPaneWidth: 360,
      entriesPaneWidth: 420,
      inspectorPaneWidth: 420,
      booksPaneWidth: 260,
      rowDensity: 'compact',
      visibleEntryMetadata: [],
    },
    updateSettings: () => undefined,
  }),
}))

mock.module('@/components/shared/WorldBookEntryEditor', () => ({
  default: () => createElement('div', { 'data-entry-editor': true }),
}))

const { act, createElement } = await import('react')

let createRoot: typeof CreateRoot
let LorebookEditorWorkspace: typeof import('./LorebookEditorWorkspace').default

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: LorebookEditorWorkspace } = await import('./LorebookEditorWorkspace'))
})

const waitFor = async (predicate: () => boolean, description = 'condition') => {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
  throw new Error(`timed out waiting for ${description}`)
}

let host: HTMLDivElement | null = null
let root: Root | null = null

const renderWorkspace = async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(LorebookEditorWorkspace, { variant: 'full', initialBookId: 'book-1' }))
  })
  await waitFor(() => host!.querySelector('[data-entry-id="entry-1"]') !== null, 'the entry list')
}

const selectEntry = async (entryId: string) => {
  const box = host!.querySelector<HTMLInputElement>(`input[aria-label="Select ${entryId}"]`)
  if (!box) throw new Error(`selection checkbox for ${entryId} not found`)
  await act(async () => { box.click() })
}

const inspectEntry = async (entryId: string) => {
  // The row itself is the inspect target: its click handler is what sets the
  // inspector's selected entry.
  const row = host!.querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`)
  if (!row) throw new Error(`entry row for ${entryId} not found`)
  await act(async () => { row.click() })
}

const control = <T extends Element>(label: string): T => {
  const element = host!.querySelector<T>(`[aria-label="${label}"]`)
  if (!element) throw new Error(`bulk control ${label} not found`)
  return element
}

/** Writes through the native setter so React's value tracker sees a real change. */
const setInputValue = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

const setSelectValue = async (select: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(select, value)
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}

const buttonWithText = (label: string) => {
  const button = [...host!.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  if (!button) throw new Error(`${label} button not found`)
  return button
}

/** The inspector pane title carries the workspace's only Saved indicator. */
const inspectorTitle = () => host!.querySelector('aside.inspectorPane .paneTitle')?.textContent ?? ''

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  host = null
  document.body.replaceChildren()
  toasts.length = 0
  state.entries = []
  state.bulkCalls = []
  state.entryListCalls = 0
  state.bulkError = null
  state.failNextEntryList = false
  state.entryListHandler = null
})

afterAll(() => {
  for (const [key, value] of previousGlobals) {
    if (value === undefined) Reflect.deleteProperty(globalObject, key)
    else Reflect.set(globalObject, key, value)
  }
  dom.window.close()
})

describe('LorebookEditorWorkspace bulk Apply', () => {
  test('clears a stale Saved indicator on a rejected Apply and keeps the retained form', async () => {
    state.entries = [entry('entry-1'), entry('entry-2')]
    await renderWorkspace()

    // A first Apply that lands end to end is what puts "Saved" on screen.
    await selectEntry('entry-1')
    await setSelectValue(control<HTMLSelectElement>('Bulk enabled'), 'disabled')
    await act(async () => { buttonWithText('Apply').click() })
    await waitFor(() => inspectorTitle().includes('Saved'), 'Saved after the first Apply')
    expect(state.bulkCalls).toHaveLength(1)
    expect(state.bulkCalls[0]!.input).toEqual({
      action: 'set_fields',
      entry_ids: ['entry-1'],
      fields: { disabled: true },
      expected_revisions: { 'entry-1': 1 },
    })

    // The next attempt must not inherit that indicator, and a rejection must not
    // be replayed automatically.
    state.bulkError = new MockApiError(400, 'Bad Request', { error: 'invalid_set_fields' })
    await setInputValue(control<HTMLInputElement>('Bulk priority'), '25')
    await act(async () => { buttonWithText('Apply').click() })
    await waitFor(() => toasts.length === 1, 'the rejection toast')

    expect(inspectorTitle()).not.toContain('Saved')
    expect(toasts).toEqual([{ type: 'error', message: 'Bulk update rejected: invalid_set_fields' }])
    expect(state.bulkCalls).toHaveLength(2)
    expect(control<HTMLInputElement>('Bulk priority').value).toBe('25')
    expect(control<HTMLSelectElement>('Bulk enabled').value).toBe('disabled')
    expect(host!.textContent).toContain('1 selected')
    // The rejection still owes a re-read, so it raises the same gate.
    expect(host!.querySelector('[data-bulk-notice="unconfirmed"]')).not.toBeNull()
    expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { buttonWithText('Reload entries').click() })
    await waitFor(() => host!.querySelector('[data-bulk-notice]') === null, 'the rejection notice to clear')
    expect(inspectorTitle()).not.toContain('Saved')
    expect(state.bulkCalls).toHaveLength(2)
  })

  test('reports a definite rejection with no details without claiming the write landed', async () => {
    state.entries = [entry('entry-1')]
    await renderWorkspace()
    await selectEntry('entry-1')
    await setSelectValue(control<HTMLSelectElement>('Bulk enabled'), 'enabled')
    // A bare 4xx: the anchor has no body and no status text to quote.
    state.bulkError = new MockApiError(400, '')
    await act(async () => { buttonWithText('Apply').click() })
    await waitFor(() => toasts.length === 1, 'the rejection toast')

    expect(toasts).toEqual([{ type: 'error', message: 'Bulk update could not be confirmed. Reload the entries before applying again.' }])
    expect(state.bulkCalls).toHaveLength(1)
    expect(inspectorTitle()).not.toContain('Saved')
    // Even a definite rejection owes the user a re-read before the next write.
    expect(host!.querySelector('[data-bulk-notice="unconfirmed"]')).not.toBeNull()
    expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(true)
  })

  test('shows a conflict raised on a selected row that is not in the inspector', async () => {
    state.entries = [entry('entry-1'), entry('entry-2')]
    await renderWorkspace()

    await selectEntry('entry-1')
    await inspectEntry('entry-2')
    const conflict: WorldBookEntryConflictPayload = {
      error: 'world_book_entry_conflict',
      code: 'WORLD_BOOK_ENTRY_CONFLICT',
      conflicts: [{ id: 'entry-1', current: entry('entry-1', { revision: 7 }) }],
    }
    state.bulkError = new MockApiError(409, 'Conflict', conflict)
    await setSelectValue(control<HTMLSelectElement>('Bulk trigger'), 'vector')
    await act(async () => { buttonWithText('Apply').click() })
    await waitFor(() => host!.querySelector('[data-bulk-notice="conflict"]') !== null, 'the bulk conflict notice')

    const notice = host!.querySelector('[data-bulk-notice="conflict"]')!
    expect(notice.textContent).toContain('newer server revision')
    expect(notice.textContent).toContain('nothing from this Apply was written')
    expect(state.bulkCalls).toHaveLength(1)
    expect(inspectorTitle()).not.toContain('Saved')
    // The inspector shows entry-2, which never conflicted.
    expect(host!.querySelector('aside.inspectorPane .conflictBanner')).toBeNull()
    expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(true)
  })

  test('keeps the refresh-failed notice and form when the manual reload also fails, without another mutation', async () => {
    state.entries = [entry('entry-1')]
    await renderWorkspace()

    await selectEntry('entry-1')
    await setSelectValue(control<HTMLSelectElement>('Bulk trigger'), 'constant')
    state.failNextEntryList = true
    await act(async () => { buttonWithText('Apply').click() })
    await waitFor(() => host!.querySelector('[data-bulk-notice="refresh-failed"]') !== null, 'the refresh-failed notice')

    // An acknowledged write still blocks the next Apply until reconnect.
    expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { buttonWithText('Apply').click() })
    expect(state.bulkCalls).toHaveLength(1)

    // The dedicated reconcile fails too...
    state.failNextEntryList = true
    await act(async () => { buttonWithText('Reload entries').click() })
    await waitFor(() => toasts.length === 2, 'the reload failure toast')

    expect(toasts[1]).toEqual({
      type: 'error',
      message: 'Entries could not be reloaded. Use Reload entries to retry.',
    })
    // ...so the notice, the retained form and the selection stay put, the gate
    // stays shut, and the acknowledged mutation is never replayed.
    expect(host!.querySelector('[data-bulk-notice="refresh-failed"]')).not.toBeNull()
    expect(inspectorTitle()).not.toContain('Saved')
    expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(true)
    expect(control<HTMLSelectElement>('Bulk trigger').value).toBe('constant')
    expect(host!.textContent).toContain('1 selected')
    expect(state.bulkCalls).toHaveLength(1)

    // A later reload that succeeds is what reopens Apply and, for this kind only,
    // may report the write as saved.
    await act(async () => { buttonWithText('Reload entries').click() })
    await waitFor(() => host!.querySelector('[data-bulk-notice]') === null, 'the notice to clear after a successful reload')

    expect(inspectorTitle()).toContain('Saved')
    expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(false)
    expect(control<HTMLSelectElement>('Bulk trigger').value).toBe('constant')
    expect(state.bulkCalls).toHaveLength(1)
  })

  test('clears the notice when the toolbar Refresh does the reconcile, and never claims Saved for an unconfirmed write', async () => {
    state.entries = [entry('entry-1')]
    await renderWorkspace()

    await selectEntry('entry-1')
    await setSelectValue(control<HTMLSelectElement>('Bulk trigger'), 'vector')
    state.bulkError = new MockApiError(502, 'Bad Gateway')
    await act(async () => { buttonWithText('Apply').click() })
    await waitFor(() => host!.querySelector('[data-bulk-notice="unconfirmed"]') !== null, 'the unconfirmed notice')

    // The toolbar Refresh is the same reconcile the notice asks for.
    await act(async () => { buttonWithText('Refresh').click() })
    await waitFor(() => host!.querySelector('[data-bulk-notice]') === null, 'the notice to clear after toolbar Refresh')

    // A successful GET supplies current revisions but cannot confirm the POST.
    expect(inspectorTitle()).not.toContain('Saved')
    expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(false)
    expect(control<HTMLSelectElement>('Bulk trigger').value).toBe('vector')
    expect(state.bulkCalls).toHaveLength(1)
  })

  for (const honorsAbort of [true, false]) {
    test(`keeps Apply blocked after an ${honorsAbort ? 'aborted' : 'superseded'} reload until current entries are committed`, async () => {
      state.entries = [entry('entry-1')]
      await renderWorkspace()
      await selectEntry('entry-1')
      await setSelectValue(control<HTMLSelectElement>('Bulk enabled'), 'disabled')
      state.failNextEntryList = true
      await act(async () => { buttonWithText('Apply').click() })
      await waitFor(() => host!.querySelector('[data-bulk-notice="refresh-failed"]') !== null, 'the refresh-failed notice')

      const staleEntries = state.entries
      state.entries = [entry('entry-1', { revision: 2, disabled: true })]
      const reloads: Array<{
        signal?: AbortSignal
        resolve: (entries: WorldBookEntry[]) => void
        reject: (error: Error) => void
      }> = []
      state.entryListHandler = (_bookId, options) => new Promise((resolve, reject) => {
        reloads.push({ signal: options?.signal, resolve, reject })
        if (honorsAbort) {
          options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        }
      })

      await act(async () => { buttonWithText('Reload entries').click() })
      await waitFor(() => reloads.length === 1, 'the first reload')
      await act(async () => { buttonWithText('Refresh').click() })
      await waitFor(() => reloads.length === 2, 'the replacement reload')
      expect(reloads[0]!.signal?.aborted).toBe(true)
      if (!honorsAbort) {
        // A transport may finish despite cancellation; its payload is stale too.
        await act(async () => { reloads[0]!.resolve(staleEntries) })
      }
      expect(host!.querySelector('[data-bulk-notice="refresh-failed"]')).not.toBeNull()
      expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(true)
      expect(inspectorTitle()).not.toContain('Saved')
      await act(async () => { buttonWithText('Apply').click() })
      expect(state.bulkCalls).toHaveLength(1)

      // Failure of the current request must leave the notice and gate intact.
      await act(async () => { reloads[1]!.reject(new Error('entries unavailable')) })
      await waitFor(() => toasts.length === 2, 'the replacement reload failure')
      expect(host!.querySelector('[data-bulk-notice="refresh-failed"]')).not.toBeNull()
      expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(true)
      expect(inspectorTitle()).not.toContain('Saved')

      await act(async () => { buttonWithText('Reload entries').click() })
      await waitFor(() => reloads.length === 3, 'the retry reload')
      await act(async () => { reloads[2]!.resolve(state.entries) })
      await waitFor(() => host!.querySelector('[data-bulk-notice]') === null, 'the successful reconciliation')
      expect(inspectorTitle()).toContain('Saved')
      expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(false)
      expect(control<HTMLSelectElement>('Bulk enabled').value).toBe('disabled')

      state.entryListHandler = null
      await act(async () => { buttonWithText('Apply').click() })
      await waitFor(() => state.bulkCalls.length === 2, 'the next Apply')
      expect(state.bulkCalls[1]!.input.expected_revisions).toEqual({ 'entry-1': 2 })
    })
  }

  test('leaves Apply disabled while nothing would be sent', async () => {
    state.entries = [entry('entry-1')]
    await renderWorkspace()

    // The bar is closed with nothing selected, so Apply does not exist yet.
    expect([...host!.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Apply')).toBe(false)

    // Selecting reveals it, and Apply is still shut because no patch exists.
    await selectEntry('entry-1')
    expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(true)

    await setInputValue(control<HTMLInputElement>('Bulk priority'), 'garbage')
    expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(true)

    await setInputValue(control<HTMLInputElement>('Bulk priority'), '3')
    expect((buttonWithText('Apply') as HTMLButtonElement).disabled).toBe(false)

    await act(async () => { buttonWithText('Apply').click() })
    await waitFor(() => state.bulkCalls.length === 1, 'the Apply request')
    expect(state.bulkCalls[0]!.input).toEqual({
      action: 'set_fields',
      entry_ids: ['entry-1'],
      fields: { priority: 3 },
      expected_revisions: { 'entry-1': 1 },
    })
  })

  test('applies a mixed sparse patch to every selected entry in one request', async () => {
    state.entries = [entry('entry-1'), entry('entry-2')]
    await renderWorkspace()

    await selectEntry('entry-1')
    await selectEntry('entry-2')
    await setInputValue(control<HTMLInputElement>('Bulk priority'), '0')
    await setSelectValue(control<HTMLSelectElement>('Bulk trigger'), 'vector')
    await setSelectValue(control<HTMLSelectElement>('Bulk enabled'), 'enabled')
    await act(async () => { buttonWithText('Apply').click() })
    await waitFor(() => inspectorTitle().includes('Saved'), 'Saved after a clean Apply')

    expect(state.bulkCalls).toHaveLength(1)
    expect(state.bulkCalls[0]!.input).toEqual({
      action: 'set_fields',
      entry_ids: ['entry-1', 'entry-2'],
      fields: { priority: 0, constant: false, vectorized: true, disabled: false },
      expected_revisions: { 'entry-1': 1, 'entry-2': 1 },
    })
    expect(host!.querySelector('[data-bulk-notice]')).toBeNull()
    expect(host!.textContent).toContain('2 selected')
  })

  test('keeps Duplicate and Delete on the shared runner without field-patch aliases', async () => {
    state.entries = [entry('entry-1')]
    await renderWorkspace()

    await selectEntry('entry-1')
    await act(async () => { buttonWithText('Duplicate').click() })
    await waitFor(() => state.bulkCalls.length === 1, 'the copy request')
    expect(state.bulkCalls[0]!.input).toEqual({
      action: 'copy',
      entry_ids: ['entry-1'],
      target_book_id: 'book-1',
      expected_revisions: { 'entry-1': 1 },
    })

    await act(async () => { buttonWithText('Delete').click() })
    await waitFor(() => state.bulkCalls.length === 2, 'the delete request')
    expect(state.bulkCalls[1]!.input).toEqual({
      action: 'delete',
      entry_ids: ['entry-1'],
      expected_revisions: { 'entry-1': 1 },
    })
    await waitFor(() => !host!.textContent!.includes('1 selected'), 'the selection to clear after delete')
  })

  test('surfaces a failed Delete on the shared runner without clearing the selection', async () => {
    state.entries = [entry('entry-1')]
    await renderWorkspace()

    await selectEntry('entry-1')
    state.failNextEntryList = true
    await act(async () => { buttonWithText('Delete').click() })
    await waitFor(() => toasts.length === 1, 'the delete failure toast')

    expect(toasts).toEqual([{ type: 'error', message: 'Delete failed. Reload the entries before trying again.' }])
    expect(state.bulkCalls).toHaveLength(1)
    expect(state.bulkCalls[0]!.input).toEqual({
      action: 'delete',
      entry_ids: ['entry-1'],
      expected_revisions: { 'entry-1': 1 },
    })
    // The runner rethrew, so deleteSelected never reached its selection reset.
    expect(host!.textContent).toContain('1 selected')
    expect(inspectorTitle()).not.toContain('Saved')
    expect(host!.querySelector('[data-bulk-notice]')).toBeNull()
  })

  test('surfaces a failed Duplicate on the shared runner and keeps the selection for a retry', async () => {
    state.entries = [entry('entry-1')]
    await renderWorkspace()

    await selectEntry('entry-1')
    state.failNextEntryList = true
    await act(async () => { buttonWithText('Duplicate').click() })
    await waitFor(() => toasts.length === 1, 'the duplicate failure toast')

    expect(toasts).toEqual([{ type: 'error', message: 'Duplicate failed. Reload the entries before trying again.' }])
    expect(state.bulkCalls).toHaveLength(1)
    expect(state.bulkCalls[0]!.input).toEqual({
      action: 'copy',
      entry_ids: ['entry-1'],
      target_book_id: 'book-1',
      expected_revisions: { 'entry-1': 1 },
    })
    expect(host!.textContent).toContain('1 selected')
    expect(inspectorTitle()).not.toContain('Saved')
    expect(host!.querySelector('[data-bulk-notice]')).toBeNull()
  })
})
