import { describe, expect, mock, test } from 'bun:test'
import { isExtensionComposerActionId } from './composerActionOwnership'

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
  buildComposerActionMap,
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
    expect(COMPOSER_ACTION_IDS).toContain('connectionsPicker')
    expect(COMPOSER_ACTION_CATALOG.some((action) => action.id === 'connectionsPicker' && action.label === 'composerCustomize.actions.connectionsPicker.label')).toBe(true)
    expect(COMPOSER_ACTION_IDS).toContain('agentRetry')
    expect(COMPOSER_ACTION_CATALOG.some((action) => action.id === 'agentRetry' && action.label === 'composerCustomize.actions.agentRetry.label')).toBe(true)

    const pristine = loadComposerActionBar()
    expect(pristine.order).toContain('selectMessages')
    expect(pristine.hidden).toContain('selectMessages')
  })

  test('gates every Suite and Quick Toolbar item from the presented composer catalog', () => {
    const quickToolbarCatalog = [
      { id: 'connections', label: 'Connections menu', description: 'Open connections', icon: ListChecks, surface: { kind: 'command' as const }, run: () => undefined },
      { id: 'chat.customize-composer', label: 'Customize composer', description: 'Customize composer actions', icon: ListChecks, surface: { kind: 'command' as const }, run: () => undefined },
      { id: 'lumiverse_suite.lorebook.open_half', label: 'Half-Screen Lorebook Editor', description: 'Open half editor', icon: ListChecks, surface: { kind: 'command' as const }, run: () => undefined },
      { id: 'lumiverse_suite.lorebook.open_enhanced', label: 'Full-Screen Lorebook Editor', description: 'Open full editor', icon: ListChecks, surface: { kind: 'command' as const }, run: () => undefined },
      { id: 'lumiverse_suite.connections_picker.open', label: 'Connections Picker', description: 'Open picker', icon: ListChecks, surface: { kind: 'command' as const }, run: () => undefined },
    ] as Parameters<typeof buildComposerActionMap>[0]

    const withoutSuite = buildComposerActionMap(quickToolbarCatalog, false)
    expect(withoutSuite.has('connections')).toBe(true)
    expect(withoutSuite.has('chat.customize-composer')).toBe(false)
    expect(withoutSuite.has('connectionsPicker')).toBe(false)
    expect(withoutSuite.has('qt:connections')).toBe(false)
    expect(withoutSuite.has('lumiverse_suite.lorebook.open_half')).toBe(false)
    expect(withoutSuite.has('lumiverse_suite.lorebook.open_enhanced')).toBe(false)
    expect(withoutSuite.has('lumiverse_suite.connections_picker.open')).toBe(false)

    const withSuite = buildComposerActionMap(quickToolbarCatalog, true)
    expect(withSuite.has('connectionsPicker')).toBe(true)
    expect(withSuite.has('qt:connections')).toBe(true)
    expect(withSuite.has('chat.customize-composer')).toBe(true)
    expect(withSuite.has('lumiverse_suite.lorebook.open_half')).toBe(true)
    expect(withSuite.has('lumiverse_suite.lorebook.open_enhanced')).toBe(true)
    expect(withSuite.has('lumiverse_suite.connections_picker.open')).toBe(false)
  })

  test('retains native composer actions when Suite-owned persisted actions are gated', () => {
    expect(isExtensionComposerActionId('chat.customize-composer')).toBe(true)
    expect(isExtensionComposerActionId('home')).toBe(false)
    expect(isExtensionComposerActionId('selectMessages')).toBe(false)
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
  test('A0 retry remains reorderable with native selectMessages customization', () => {
    const customized = normalizeComposerActionBarState({
      order: ['agentRetry', 'selectMessages', 'home'],
      hidden: [],
    })
    expect(customized.order.slice(0, 3)).toEqual(['agentRetry', 'selectMessages', 'home'])
    expect(customized.hidden).not.toContain('agentRetry')
    expect(customized.hidden).not.toContain('selectMessages')
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
