/// <reference types="bun-types" />

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { ListChecks } from 'lucide-react'
import type { ToolbarAction } from '@/components/quick-toolbar/useQuickToolbarActions'
import { isCoreOwnedComposerActionId, isExtensionComposerActionId } from './composerActionOwnership'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const storeState = {
  messageSelectMode: false,
  selectedMessageIds: ['msg-1'],
  /** Extension identity slices the composer catalog reads; empty here. */
  inputBarActions: [],
  drawerTabs: [],
  extensions: [
    { id: 'lumiverse_suite', identifier: 'lumiverse_suite', enabled: true, has_frontend: true },
  ],
  setMessageSelectMode(enabled: boolean) {
    this.messageSelectMode = enabled
    this.selectedMessageIds = []
  },
}

/** Toolbar catalog the modal consumes, as the live hook would return it. */
let toolbarCatalog: ToolbarAction[] = []

// The modal reads the store both as a hook (`useStore(selector)`) and
// synchronously (`useStore.getState()`), so the stand-in must be callable with
// the statics attached rather than an object that only carries `getState`.
const useStore = ((selector: (value: typeof storeState) => unknown) => selector(storeState)) as typeof import('@/store').useStore
useStore.getState = () => storeState as unknown as ReturnType<typeof useStore.getState>
useStore.subscribe = (() => () => undefined) as typeof useStore.subscribe

mock.module('@/store', () => ({ useStore }))
mock.module('@/components/quick-toolbar/useQuickToolbarActions', () => ({
  useQuickToolbarActions: () => ({ actionCatalog: toolbarCatalog }),
}))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: () => null }))
mock.module('@/components/shared/ModalShell', () => ({ ModalShell: ({ children }: { children?: unknown }) => children }))
mock.module('@/components/shared/Toggle', () => ({ Toggle: { Switch: () => null } }))
mock.module('@/lib/dndUiScale', () => ({
  DndContext: ({ children }: { children?: unknown }) => children,
  useScaledSortableStyle: () => ({ setNodeRef: () => undefined, style: {} }),
}))
mock.module('@/lib/toolbarActionSearch', () => ({
  filterActionIds: (ids: string[]) => ids,
  filterActions: (actions: unknown[]) => actions,
}))
mock.module('./InputArea.module.css', () => ({ default: new Proxy({}, { get: (_target, key) => String(key) }) }))

const {
  COMPOSER_ACTION_CATALOG,
  COMPOSER_ACTION_IDS,
  buildComposerActionMap,
  composerExtraItem,
  loadComposerActionBar,
  normalizeComposerActionBarState,
  runComposerSelectMessages,
  toComposerExtraId,
} = await import('./InputAreaCustomizeModal')

let createRoot: typeof CreateRoot
let InputAreaCustomizeModal: typeof import('./InputAreaCustomizeModal').default

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: InputAreaCustomizeModal } = await import('./InputAreaCustomizeModal'))
})

afterEach(() => {
  document.body.replaceChildren()
  toolbarCatalog = []
})

const DRAWER_ID = 'ext-action:["drawer","ext_owner","settings-page"]'
const DRAWER_RUNTIME_ID = 'spindle:ext_owner:tab:settings-page:7'

function drawerLaunchAction(): ToolbarAction {
  return {
    id: DRAWER_ID,
    label: 'Owner settings',
    description: 'Open the owner settings tab',
    icon: () => null,
    surface: { kind: 'drawer', tabId: DRAWER_RUNTIME_ID },
    run: () => undefined,
  }
}

function Probe({ order, hidden }: { order: string[]; hidden: string[] }) {
  return (
    <InputAreaCustomizeModal
      onClose={() => undefined}
      order={order}
      hidden={hidden}
      onToggle={() => undefined}
      onReorder={() => undefined}
      onReset={() => undefined}
    />
  )
}

describe('composer selectMessages catalog and migration', () => {
  test('native selectMessages is catalog-present with ListChecks and hidden in pristine defaults', () => {
    const matches = COMPOSER_ACTION_CATALOG.filter((action) => action.id === 'selectMessages')
    expect(matches).toHaveLength(1)
    expect(matches[0].icon).toBe(ListChecks)
    expect(COMPOSER_ACTION_IDS).toContain('selectMessages')
    expect(COMPOSER_ACTION_IDS).toContain('connectionsPicker')
    expect(COMPOSER_ACTION_CATALOG.some((action) => action.id === 'connectionsPicker' && action.label === 'Connections Picker')).toBe(true)

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
    expect(withSuite.has('chat.customize-composer')).toBe(false)
    expect(withSuite.has('lumiverse_suite.lorebook.open_half')).toBe(true)
    expect(withSuite.has('lumiverse_suite.lorebook.open_enhanced')).toBe(true)
    // The extension contribution is represented by the stable native launcher.
    expect(withSuite.has('lumiverse_suite.connections_picker.open')).toBe(false)
  })
  test('reserves the native customizer while retaining other native composer actions', () => {
    expect(isCoreOwnedComposerActionId('chat.customize-composer')).toBe(true)
    expect(isExtensionComposerActionId('chat.customize-composer')).toBe(false)
    expect(isExtensionComposerActionId('home')).toBe(false)
    expect(isExtensionComposerActionId('selectMessages')).toBe(false)
  })

  test('prunes a legacy catalog-inserted customizer in favor of the pinned native launcher', () => {
    const normalized = normalizeComposerActionBarState({
      order: ['home', 'chat.customize-composer', 'regen'],
      hidden: ['chat.customize-composer'],
    })

    expect(normalized.order).not.toContain('chat.customize-composer')
    expect(normalized.hidden).not.toContain('chat.customize-composer')
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

  test('lists an extension drawer launch action by its canonical id', async () => {
    // The modal consumes the toolbar catalog as it always has: every entry except
    // the dedicated Suite connections-picker row is listed, and a drawer launch
    // action keeps its canonical id and its drawer surface.
    const drawer = drawerLaunchAction()
    toolbarCatalog = [drawer]
    expect(composerExtraItem(drawer).id).toBe(DRAWER_ID)
    expect(toComposerExtraId(DRAWER_ID)).toBe(DRAWER_ID)

    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    await act(async () => {
      root.render(<Probe order={['home']} hidden={[]} />)
      await Promise.resolve()
    })

    const labels = [...host.querySelectorAll('*')]
      .map((node) => node.textContent ?? '')
    expect(labels.some((text) => text.includes('Owner settings'))).toBe(true)
    expect(host.textContent).toContain('Composer icons')

    await act(async () => root.unmount())
  })

  test('still omits the dedicated Suite connections-picker toolbar row', async () => {
    toolbarCatalog = [{
      id: 'lumiverse_suite.connections_picker.open',
      label: 'Connections Picker toolbar row',
      description: 'Toolbar duplicate of the native composer button',
      icon: () => null,
      surface: { kind: 'command' },
      run: () => undefined,
    }]
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    await act(async () => {
      root.render(<Probe order={['home']} hidden={[]} />)
      await Promise.resolve()
    })

    expect(host.textContent).not.toContain('Connections Picker toolbar row')

    await act(async () => root.unmount())
  })
})
