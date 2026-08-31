import { afterAll, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { WorldBookEntry } from '@/types/api'

const noop = () => null
mock.module('@/lib/i18n/worldBookEntryLabels', () => ({ useWorldBookEntryLabels: () => ({}) }))
mock.module('@/lib/i18n/loomOptionLabels', () => ({ useLoomOptionLabels: () => ({}) }))
mock.module('@/lib/dndUiScale', () => ({ useScaledSortableStyle: (input: unknown) => input }))
mock.module('@/hooks/useScrollGate', () => ({ useScrollGate: noop }))
mock.module('@/hooks/useIsMobile', () => ({ default: () => false }))
mock.module('@/api/world-books', () => ({ worldBooksApi: {} }))
mock.module('@/ws/client', () => ({ wsClient: { on: () => () => {} } }))
mock.module('@/ws/events', () => ({ EventType: {} }))
mock.module('@/components/shared/WorldBookEntryEditor', () => ({ default: noop }))
mock.module('@/components/panels/world-book/WorldBookTokenReportModal', () => ({ default: noop }))
mock.module('@/components/shared/ConfirmationModal', () => ({ default: noop }))
mock.module('@/components/shared/ContextMenu', () => ({ default: noop }))
mock.module('@/components/shared/ModalPresentation', () => ({ ModalPresentation: noop }))
mock.module('@/components/shared/SearchableSelect', () => ({ default: noop }))
mock.module('@/components/shared/FormComponents', () => ({ FormField: noop, Select: noop, TextInput: noop, Button: noop }))
mock.module('@/components/shared/Pagination', () => ({ default: noop }))
mock.module('@/store', () => ({ useStore: () => ({}) }))
mock.module('@/lib/clearableSearch', () => ({ clearSearchOnEscape: noop }))
mock.module('@dnd-kit/core', () => ({
  DndContext: noop, MouseSensor: noop, TouchSensor: noop, KeyboardSensor: noop, DragOverlay: noop,
  closestCenter: noop, useSensor: noop, useSensors: noop,
}))
mock.module('@dnd-kit/sortable', () => ({
  SortableContext: noop, arrayMove: noop, sortableKeyboardCoordinates: noop,
  useSortable: () => ({}), verticalListSortingStrategy: noop,
}))
mock.module('lucide-react', () => ({
  ArrowDown: noop, ArrowUp: noop, ArrowUpDown: noop, CheckSquare: noop,
  ChevronDown: noop, ChevronRight: noop, Copy: noop, GripVertical: noop,
  Hash: noop, MoreVertical: noop, MoveRight: noop, Plus: noop, Plug: noop,
  Search: noop, Square: noop, Tag: noop, Trash2: noop, X: noop,
  ArrowBigUp: noop, ArrowBigDown: noop, BetweenHorizontalStart: noop,
  BetweenHorizontalEnd: noop, Lock: noop, MapPin: noop, Zap: noop,
  FileText: noop,
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const globalObject = globalThis as unknown as Record<string, unknown>
const originalWindow = globalObject.window
globalObject.window = dom.window

Object.defineProperty(dom.window, 'matchMedia', {
  configurable: true,
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
})

afterAll(() => {
  if (originalWindow === undefined) delete globalObject.window
  else globalObject.window = originalWindow
  dom.window.close()
})

const {
  applyWorldBookEntryViewPreference,
  getWorldBookEntriesSectionBookResetState,
  shouldLoadFullWorldBookEntryCorpus,
  sortWorldBookEntriesForView,
} = await import('./WorldBookEntriesSection')
type WorldBookEntriesSectionViewState = import('./WorldBookEntriesSection').WorldBookEntriesSectionViewState

function editorState(): WorldBookEntriesSectionViewState {
  return {
    ...getWorldBookEntriesSectionBookResetState(),
    sortBy: 'priority',
    sortDir: 'desc',
    pageSize: 100,
    entryPage: 3,
    entrySearchFilter: 'dragon',
    mobileListOptionsOpen: true,
    selectedEntryId: 'entry-1',
    showTokenReport: true,
    selectMode: true,
    selectedIds: ['entry-1'],
    contextMenu: null,
    typeMenu: null,
    positionMenu: null,
    bulkActionsMenu: null,
    activationState: null,
  }
}

describe('WorldBookEntriesSection view reset boundaries', () => {
  test('reserves full-corpus loading for book-wide tools', () => {
    expect(shouldLoadFullWorldBookEntryCorpus('', 'all', 50)).toBe(false)
    expect(shouldLoadFullWorldBookEntryCorpus('dragon', 'all', 50)).toBe(true)
    expect(shouldLoadFullWorldBookEntryCorpus('', 'vector', 50)).toBe(true)
    expect(shouldLoadFullWorldBookEntryCorpus('', 'all', 'all')).toBe(true)
  })

  test('restores the authored array for custom order and sorts other views without mutating it', () => {
    const authored = [
      { id: 'b', comment: 'Second', priority: 1, created_at: 20, updated_at: 20 } as WorldBookEntry,
      { id: 'c', comment: 'Third', priority: 2, created_at: 30, updated_at: 30 } as WorldBookEntry,
      { id: 'a', comment: 'First', priority: 1, created_at: 10, updated_at: 10 } as WorldBookEntry,
    ]

    expect(sortWorldBookEntriesForView(authored, 'custom', 'asc')).toBe(authored)
    expect(sortWorldBookEntriesForView(authored, 'priority', 'desc').map((entry) => entry.id)).toEqual(['c', 'a', 'b'])
    expect(authored.map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
  })

  test('preference-object replacement changes only primitive view preferences', () => {
    const next = applyWorldBookEntryViewPreference(editorState(), {
      sortBy: 'name',
      sortDir: 'asc',
      pageSize: 200,
    })

    expect(next).toMatchObject({
      sortBy: 'name',
      sortDir: 'asc',
      pageSize: 200,
      entryPage: 3,
      entrySearchFilter: 'dragon',
      entryTypeFilter: 'all',
      mobileListOptionsOpen: true,
      selectedEntryId: 'entry-1',
      showTokenReport: true,
      selectMode: true,
      selectedIds: ['entry-1'],
    })
  })

  test('actual book-change reset clears editor state and navigation-local state', () => {
    const reset = getWorldBookEntriesSectionBookResetState()
    expect(reset).toEqual({
      entryPage: 1,
      entrySearchFilter: '',
      entryTypeFilter: 'all',
      mobileListOptionsOpen: false,
      selectedEntryId: null,
      showTokenReport: false,
      selectMode: false,
      selectedIds: [],
      contextMenu: null,
      typeMenu: null,
      positionMenu: null,
      bulkActionsMenu: null,
      activationState: null,
    })
  })
})
