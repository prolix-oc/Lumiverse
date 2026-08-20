/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { resolve } from 'node:path'
import { isOpaqueToolbarBackdrop } from './quickToolbarDock'

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
])
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cssProxy = new Proxy({}, { get: (_target, key) => String(key) })
mock.module('./QuickToolbar.module.css', () => ({ default: cssProxy }))
mock.module('./QuickToolbarCustomizeModal', () => ({ default: () => null }))
mock.module('./useQuickToolbarContext', () => ({ useQuickToolbarContext: () => ({}) }))
mock.module('@/lib/avatarUrls', () => ({ getCharacterAvatarThumbUrl: () => null }))
mock.module('@/lib/lorebookWorkspaceVisibility', () => ({ useLorebookWorkspaceOverlayOpen: () => false }))
mock.module('@/lib/uiProductivityDefaults', () => ({
  isMobileViewportOrDevice: () => false,
  shouldHideQuickToolbarWhenOverlaid: () => false,
}))
mock.module('@/lib/quickToolbarGeometry', () => ({
  resolveToolbarRect: (rect: { x: number; y: number; width: number; height: number }) => rect,
  selectToolbarRect: (settings: { rect: { x: number; y: number; width: number; height: number } }) => settings.rect,
  toolbarRectBounds: () => ({ minWidth: 0, minHeight: 0, maxWidth: 920, maxHeight: 640 }),
  withToolbarPosition: (_settings: unknown, next: unknown) => next,
  withToolbarRect: (_settings: unknown, _orientation: unknown, next: unknown) => next,
}))
mock.module('@/lib/quickToolbarPlacement', () => ({
  CUSTOMIZER_WIDTH: 320,
  placeCustomizer: () => ({ left: 0, top: 0, maxHeight: 400, side: 'below', caret: 14 }),
  readUiScale: () => 1,
}))
mock.module('@/lib/quickToolbarToggle', () => ({
  isSurfaceActive: () => false,
  isToolbarActionActive: () => false,
}))
mock.module('@/lib/toolbarActionSearch', () => ({
  canMoveWithinFiltered: () => false,
  filterActionIds: (ids: string[]) => ids,
}))
mock.module('@/hooks/usePersistentRect', () => ({
  usePersistentRect: ({ rect }: { rect: { x: number; y: number; width: number; height: number } }) => ({
    rect,
    startDrag: () => undefined,
  }),
}))

const settings = {
  enabled: true,
  variant: 'v2-settings-adjacent' as const,
  visibleTabIds: ['chat.new'] as string[],
  iconOrder: ['chat.new'] as string[],
  iconSize: 20,
  labelVisible: false,
  labelTextSize: 11,
  scale: 1,
  orientation: 'horizontal',
  rotationDeg: 0,
  opacity: 1,
  snapToEdge: false,
  resizeHandlesEnabled: false,
  rect: { x: 24, y: 24, width: 0, height: 0 },
  verticalSize: { width: 0, height: 0 },
  rectVersion: 3,
  modalRestoreHandle: false,
  v2IconSize: 28,
  v2LabelTextSize: 11,
  v2LabelVisible: false,
  v2Density: 'comfortable',
  v2IconOnly: true,
  autoFitBounds: true,
  opaqueToolbarBackdrop: false as boolean,
  fillTopDockWidth: true,
  quickToolbarPlacement: 'floating' as const,
}

const catalogActions = [{
  id: 'chat.new',
  label: 'chat.new',
  description: 'chat.new',
  icon: () => <span data-icon="chat.new" />,
  surface: { kind: 'command' as const },
  run: () => undefined,
}]

mock.module('./useQuickToolbarActions', () => ({
  useQuickToolbarActions: () => ({
    settings,
    updateSettings: (patch: Partial<typeof settings>) => Object.assign(settings, patch),
    actionCatalog: catalogActions,
    actionById: new Map(catalogActions.map((action) => [action.id, action])),
    actions: catalogActions,
    visibleIds: catalogActions.map((action) => action.id),
    orderedIds: catalogActions.map((action) => action.id),
    catalogOrder: catalogActions.map((action) => action.id),
    moveActionWithin: () => undefined,
    toggleAction: () => undefined,
    resetCurrentVariant: () => undefined,
  }),
}))

const storeState = {
  drawerOpen: false,
  drawerTab: '',
  settingsModalOpen: false,
  settingsActiveView: '',
  editingCharacterId: null,
  lorebookHalfEditor: { open: false },
  activeModal: null,
  characters: [],
  activeCharacterId: 'char-1',
  quickToolbarSettings: settings,
}
const useStore = ((selector: (value: typeof storeState) => unknown) => selector(storeState)) as typeof import('@/store').useStore
useStore.getState = () => storeState as unknown as ReturnType<typeof useStore.getState>
mock.module('@/store', () => ({ useStore }))

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: FakeResizeObserver })
Object.assign(dom.window, { ResizeObserver: FakeResizeObserver })

let createRoot: typeof CreateRoot
let QuickToolbar: typeof import('./QuickToolbar').QuickToolbar

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ QuickToolbar } = await import('./QuickToolbar'))
})

afterEach(() => {
  document.body.replaceChildren()
  settings.opaqueToolbarBackdrop = false
})

afterAll(() => {
  for (const [key, value] of previousGlobals) {
    if (value === undefined) Reflect.deleteProperty(globalObject, key)
    else Reflect.set(globalObject, key, value)
  }
  dom.window.close()
})

async function renderToolbar(node: ReactNode = <QuickToolbar />) {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  await act(async () => {
    root.render(node)
    await Promise.resolve()
  })
  return { host, root }
}

describe('QuickToolbar opaque backdrop', () => {
  test('defaults off and emits data-opaque-backdrop only when enabled', async () => {
    expect(isOpaqueToolbarBackdrop(undefined)).toBe(false)
    expect(isOpaqueToolbarBackdrop({})).toBe(false)
    expect(isOpaqueToolbarBackdrop({ opaqueToolbarBackdrop: true })).toBe(true)

    const off = await renderToolbar()
    expect(document.querySelector('[data-component="QuickToolbar"]')?.getAttribute('data-opaque-backdrop')).toBeNull()
    await act(async () => off.root.unmount())

    settings.opaqueToolbarBackdrop = true
    const on = await renderToolbar()
    const root = document.querySelector('[data-component="QuickToolbar"]')
    expect(root?.getAttribute('data-opaque-backdrop')).toBe('1')
    await act(async () => on.root.unmount())
  })

  test('plate uses custom fallback backdrop and stays confined to the QT root', async () => {
    const css = await Bun.file(resolve(import.meta.dir, 'QuickToolbar.module.css')).text()
    const theme = await Bun.file(resolve(import.meta.dir, '../../theme/variables.css')).text()

    expect(theme).toContain('--lumiverse-bg-opaque: rgb(28 24 38)')
    expect(css).toContain(".root[data-opaque-backdrop='1']::before")
    expect(css).toContain('background: var(--quick-toolbar-backdrop-color, var(--lumiverse-bg-opaque))')
    expect(css).toMatch(/\.root\[data-opaque-backdrop='1'\]::before\s*\{[\s\S]*?inset:\s*0;/)
    expect(css).not.toMatch(/body\[data-opaque-backdrop/)
    expect(css).not.toMatch(/html\[data-opaque-backdrop/)
  })
})
