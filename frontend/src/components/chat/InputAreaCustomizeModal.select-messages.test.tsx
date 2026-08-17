import { describe, expect, mock, test } from 'bun:test'
import { ListChecks } from 'lucide-react'

const storeState = {
  messageSelectMode: false,
  selectedMessageIds: ['msg-1'],
  setMessageSelectMode(enabled: boolean) {
    this.messageSelectMode = enabled
    this.selectedMessageIds = []
  },
}

mock.module('@/store', () => ({
  useStore: {
    getState: () => storeState,
  },
}))
mock.module('@/components/quick-toolbar/useQuickToolbarActions', () => ({
  useQuickToolbarActions: () => ({ actionCatalog: [] }),
}))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: () => null }))
mock.module('@/components/shared/ModalShell', () => ({ ModalShell: ({ children }: { children?: unknown }) => children }))
mock.module('@/components/shared/Toggle', () => ({ Toggle: { Switch: () => null } }))
mock.module('@/lib/dndUiScale', () => ({ useScaledSortableStyle: () => ({ setNodeRef: () => undefined, style: {} }) }))
mock.module('@/lib/toolbarActionSearch', () => ({
  filterActionIds: (ids: string[]) => ids,
  filterActions: (actions: unknown[]) => actions,
}))
mock.module('./InputArea.module.css', () => ({ default: new Proxy({}, { get: (_target, key) => String(key) }) }))

const {
  COMPOSER_ACTION_CATALOG,
  COMPOSER_ACTION_IDS,
  loadComposerActionBar,
  normalizeComposerActionBarState,
  runComposerSelectMessages,
} = await import('./InputAreaCustomizeModal')

describe('composer selectMessages catalog and migration', () => {
  test('native selectMessages is catalog-present with ListChecks and hidden in pristine defaults', () => {
    const matches = COMPOSER_ACTION_CATALOG.filter((action) => action.id === 'selectMessages')
    expect(matches).toHaveLength(1)
    expect(matches[0].icon).toBe(ListChecks)
    expect(COMPOSER_ACTION_IDS).toContain('selectMessages')

    const pristine = loadComposerActionBar()
    expect(pristine.order).toContain('selectMessages')
    expect(pristine.hidden).toContain('selectMessages')
  })

  test('pre-feature persisted blobs append and hide selectMessages', () => {
    const migrated = normalizeComposerActionBarState({
      order: ['home', 'regen', 'continue'],
      hidden: [],
    })
    expect(migrated.order.at(-1)).toBe('selectMessages')
    expect(migrated.order).toContain('home')
    expect(migrated.hidden).toContain('selectMessages')
  })

  test('later explicit visibility choices are preserved', () => {
    const visible = normalizeComposerActionBarState({
      order: ['home', 'selectMessages', 'regen'],
      hidden: [],
    })
    expect(visible.order).toEqual([
      'home',
      'selectMessages',
      'regen',
      ...COMPOSER_ACTION_IDS.filter((id) => !['home', 'selectMessages', 'regen'].includes(id)),
    ])
    expect(visible.hidden).not.toContain('selectMessages')

    const hidden = normalizeComposerActionBarState({
      order: ['home', 'selectMessages', 'regen'],
      hidden: ['selectMessages'],
    })
    expect(hidden.hidden).toEqual(['selectMessages'])
  })

  test('runComposerSelectMessages toggles the existing store setter', () => {
    storeState.messageSelectMode = false
    storeState.selectedMessageIds = ['msg-1']
    runComposerSelectMessages()
    expect(storeState.messageSelectMode).toBe(true)
    expect(storeState.selectedMessageIds).toEqual([])
    runComposerSelectMessages()
    expect(storeState.messageSelectMode).toBe(false)
    expect(storeState.selectedMessageIds).toEqual([])
  })
})
