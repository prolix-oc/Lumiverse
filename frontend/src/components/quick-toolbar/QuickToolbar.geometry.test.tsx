/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createCoalescedLayoutScheduler } from './toolbarLayoutBatch'
import {
  normalizeQuickToolbarPlacement,
  QUICK_TOOLBAR_CHILD_FLEX,
  QUICK_TOOLBAR_DOCK_ID,
  readQuickToolbarPlacement,
} from './quickToolbarDock'

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
mock.module('@/lib/quickToolbarToggle', () => ({ isSurfaceActive: () => false }))
mock.module('@/lib/toolbarActionSearch', () => ({
  canMoveWithinFiltered: () => false,
  filterActionIds: (ids: string[]) => ids,
}))
mock.module('@/hooks/usePersistentRect', () => ({
  usePersistentRect: ({ rect }: { rect: { x: number; y: number; width: number; height: number } }) => ({
    rect,
    startDrag: startDragMock,
  }),
}))

const CHAT_DOCKER_ACTION_IDS = [
  'chat.new',
  'chat.manage',
  'chat.prompt-variables',
  'chat.settings',
  'chat.convert-to-group',
  'chat.new-group',
  'chat.authors-note',
  'chat.recompile-memories',
] as const

const startDragMock = mock(() => undefined)

const defaultSettings = {
  enabled: true,
  variant: 'v1-free',
  visibleTabIds: [...CHAT_DOCKER_ACTION_IDS],
  iconOrder: [...CHAT_DOCKER_ACTION_IDS],
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
  quickToolbarPlacement: 'floating' as 'floating' | 'chat_top_dock',
}

const settings = { ...defaultSettings }

const catalogActions = CHAT_DOCKER_ACTION_IDS.map((id) => ({
  id,
  label: id,
  description: id,
  icon: (props: { size?: number }) => <span data-icon={id} style={{ width: props.size, height: props.size }} />,
  surface: { kind: 'command' as const },
  run: () => undefined,
}))

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
  static instances: FakeResizeObserver[] = []
  disconnected = false
  constructor(public callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe() {}
  disconnect() { this.disconnected = true }
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
  Object.assign(settings, defaultSettings)
  FakeResizeObserver.instances = []
  startDragMock.mockClear()
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

describe('QuickToolbar geometry', () => {
  test('renders exactly one top dock for V1 and V2 across floating and chat_top_dock placement', async () => {
    for (const variant of ['v1-free', 'v2-settings-adjacent'] as const) {
      for (const placement of ['floating', 'chat_top_dock'] as const) {
        settings.variant = variant
        settings.quickToolbarPlacement = placement
        const { root } = await renderToolbar()
        const docks = document.querySelectorAll(`[data-quick-toolbar-dock="${QUICK_TOOLBAR_DOCK_ID}"]`)
        expect(docks, `${variant}/${placement}`).toHaveLength(1)
        expect(docks[0].getAttribute('data-quick-toolbar-placement')).toBe(placement)
        expect(docks[0].getAttribute('data-quick-toolbar-variant')).toBe(variant === 'v2-settings-adjacent' ? 'v2' : 'v1')
        await act(async () => root.unmount())
      }
    }
  })

  test('preserves dock placement through reload and viewport change', async () => {
    expect(normalizeQuickToolbarPlacement(undefined)).toBe('floating')
    expect(normalizeQuickToolbarPlacement('legacy')).toBe('floating')
    expect(readQuickToolbarPlacement({})).toBe('floating')
    settings.quickToolbarPlacement = 'chat_top_dock'
    const first = await renderToolbar()
    expect(document.querySelector('[data-quick-toolbar-placement]')?.getAttribute('data-quick-toolbar-placement')).toBe('chat_top_dock')
    await act(async () => first.root.unmount())

    const reloaded = await renderToolbar()
    expect(document.querySelector('[data-quick-toolbar-placement]')?.getAttribute('data-quick-toolbar-placement')).toBe('chat_top_dock')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 })
    window.dispatchEvent(new window.Event('resize'))
    expect(document.querySelector('[data-quick-toolbar-placement]')?.getAttribute('data-quick-toolbar-placement')).toBe('chat_top_dock')
    await act(async () => reloaded.root.unmount())
  })

  test('gives dock children correct order width and zero dead space', async () => {
    settings.variant = 'v1-free'
    settings.quickToolbarPlacement = 'chat_top_dock'
    const { host, root } = await renderToolbar()
    const dock = document.querySelector(`[data-quick-toolbar-dock="${QUICK_TOOLBAR_DOCK_ID}"]`)
    expect(dock?.getAttribute('data-dead-space')).toBe('0')
    const children = [...document.querySelectorAll<HTMLElement>('[data-toolbar-action]')]
    expect(children.map((node) => node.getAttribute('data-toolbar-action'))).toEqual([...CHAT_DOCKER_ACTION_IDS])
    for (const child of children) {
      expect(child.style.flex).toBe(QUICK_TOOLBAR_CHILD_FLEX)
    }
    expect(host.querySelector('[data-dead-space="1"]')).toBeNull()
    await act(async () => root.unmount())
  })

  test('coalesces resize updates to one layout batch per frame', () => {
    const runs: number[] = []
    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame

    const scheduler = createCoalescedLayoutScheduler(() => { runs.push(frames.length) })
    scheduler.schedule()
    scheduler.schedule()
    scheduler.schedule()
    expect(runs).toEqual([])
    expect(frames).toHaveLength(1)
    frames[0](0)
    expect(runs).toHaveLength(1)

    globalThis.requestAnimationFrame = previousRaf
  })

  test('cancels observer and animation frame work on unload', async () => {
    const runs: number[] = []
    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    const previousCancel = globalThis.cancelAnimationFrame
    let cancelled = 0
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => { cancelled += 1 }) as typeof cancelAnimationFrame

    const scheduler = createCoalescedLayoutScheduler(() => { runs.push(1) })
    scheduler.schedule()
    settings.quickToolbarPlacement = 'chat_top_dock'
    const { root } = await renderToolbar()
    await act(async () => root.unmount())
    scheduler.cancel()
    frames.forEach((frame) => frame(0))
    expect(runs).toEqual([])
    expect(cancelled).toBeGreaterThan(0)
    expect(FakeResizeObserver.instances.every((observer) => observer.disconnected)).toBe(true)

    globalThis.requestAnimationFrame = previousRaf
    globalThis.cancelAnimationFrame = previousCancel
  })
})
