/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

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
  isToolbarActionActive: (action: { active?: boolean }) => action.active === true,
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

const DESIGN_DEFAULT_IDS = [
  'chat.new',
  'chat.manage',
  'chat.prompt-variables',
  'chat.settings',
  'chat.convert-to-group',
  'chat.new-group',
  'chat.authors-note',
  'chat.recompile-memories',
] as const

const SELECT_MESSAGES_ID = 'chat.select-messages'

const settings = {
  enabled: true,
  variant: 'v2-settings-adjacent' as const,
  visibleTabIds: [...DESIGN_DEFAULT_IDS] as string[],
  iconOrder: [...DESIGN_DEFAULT_IDS] as string[],
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
  hideWhenOverlaid: undefined as boolean | undefined,
  fillTopDockWidth: true,
  showNativeSelectMessages: true,
  opaqueToolbarBackdrop: false,
  quickToolbarPlacement: 'floating' as 'floating' | 'chat_top_dock',
}

const storeState = {
  messageSelectMode: false,
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

function selectMessagesAction() {
  return {
    id: SELECT_MESSAGES_ID,
    label: storeState.messageSelectMode ? 'Exit selection mode' : 'Select messages',
    description: 'Select messages',
    icon: () => <span data-icon={SELECT_MESSAGES_ID} />,
    surface: { kind: 'command' as const },
    run: () => undefined,
    active: storeState.messageSelectMode,
  }
}

function defaultAction(id: string) {
  return {
    id,
    label: id,
    description: id,
    icon: () => <span data-icon={id} />,
    surface: { kind: 'command' as const },
    run: () => undefined,
    active: false,
  }
}

const catalogActions = [
  ...DESIGN_DEFAULT_IDS.map((id) => defaultAction(id)),
  selectMessagesAction(),
]

function visibleActions() {
  return catalogActions.filter((action) => settings.visibleTabIds.includes(action.id))
}

mock.module('./useQuickToolbarActions', () => ({
  DESIGN_DEFAULT_IDS,
  useQuickToolbarActions: () => ({
    settings,
    updateSettings: (patch: Partial<typeof settings>) => Object.assign(settings, patch),
    actionCatalog: catalogActions,
    actionById: new Map(catalogActions.map((action) => [action.id, action])),
    actions: visibleActions(),
    visibleIds: settings.visibleTabIds,
    orderedIds: settings.iconOrder,
    catalogOrder: catalogActions.map((action) => action.id),
    moveActionWithin: () => undefined,
    toggleAction: () => undefined,
    resetCurrentVariant: () => undefined,
  }),
}))

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
  storeState.messageSelectMode = false
  settings.visibleTabIds = [...DESIGN_DEFAULT_IDS]
  settings.iconOrder = [...DESIGN_DEFAULT_IDS]
  catalogActions.splice(
    0,
    catalogActions.length,
    ...DESIGN_DEFAULT_IDS.map((id) => defaultAction(id)),
    selectMessagesAction(),
  )
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

describe('QuickToolbar select-messages', () => {
  test('is available to customize and absent from untouched default icon order', async () => {
    expect(catalogActions.some((action) => action.id === SELECT_MESSAGES_ID)).toBe(true)
    expect(DESIGN_DEFAULT_IDS).not.toContain(SELECT_MESSAGES_ID)
    expect(settings.iconOrder).not.toContain(SELECT_MESSAGES_ID)
    expect(settings.visibleTabIds).not.toContain(SELECT_MESSAGES_ID)

    const { root } = await renderToolbar()
    expect(document.querySelector(`[data-toolbar-action="${SELECT_MESSAGES_ID}"]`)).toBeNull()
    await act(async () => root.unmount())
  })

  test('reacts to select mode for label, active, and aria-pressed', async () => {
    settings.visibleTabIds = [...DESIGN_DEFAULT_IDS, SELECT_MESSAGES_ID]
    settings.iconOrder = [...DESIGN_DEFAULT_IDS, SELECT_MESSAGES_ID]
    catalogActions[catalogActions.length - 1] = selectMessagesAction()

    const { root } = await renderToolbar()
    const idle = document.querySelector(`[data-toolbar-action="${SELECT_MESSAGES_ID}"]`)
    expect(idle).not.toBeNull()
    expect(idle?.getAttribute('aria-label')).toBe('Select messages')
    expect(idle?.getAttribute('aria-pressed')).toBe('false')

    storeState.messageSelectMode = true
    catalogActions[catalogActions.length - 1] = selectMessagesAction()
    await act(async () => {
      root.render(<QuickToolbar />)
      await Promise.resolve()
    })

    const active = document.querySelector(`[data-toolbar-action="${SELECT_MESSAGES_ID}"]`)
    expect(active?.getAttribute('aria-label')).toBe('Exit selection mode')
    expect(active?.getAttribute('aria-pressed')).toBe('true')

    await act(async () => root.unmount())
  })
})
