/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { QUICK_TOOLBAR_POINTER_HOLD_MS } from './quickToolbarDock'
import { createPointerHoldController, nextToolbarIconOrder } from './toolbarPointerHold'

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

function countActionId(actions: ReadonlyArray<{ id: string }>, id: string): number {
  return actions.reduce((total, action) => total + (action.id === id ? 1 : 0), 0)
}

const startDragMock = mock(() => undefined)
const reorderActionsMock = mock((ids: Array<(typeof CHAT_DOCKER_ACTION_IDS)[number]>) => {
  settings.iconOrder = ids
})
const actionRunMock = mock(() => undefined)
mock.module('@/hooks/usePersistentRect', () => ({
  usePersistentRect: ({ rect }: { rect: { x: number; y: number; width: number; height: number } }) => ({
    rect,
    startDrag: startDragMock,
  }),
}))

const settings = {
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
  resizeHandlesEnabled: true,
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

const catalogActions = CHAT_DOCKER_ACTION_IDS.map((id) => ({
  id,
  label: id,
  description: id,
  icon: () => <span data-icon={id} />,
  surface: { kind: 'command' as const },
  run: actionRunMock,
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
    reorderActions: reorderActionsMock,
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
  startDragMock.mockClear()
  reorderActionsMock.mockClear()
  actionRunMock.mockClear()
  settings.variant = 'v1-free'
  settings.quickToolbarPlacement = 'floating'
  settings.iconOrder = [...CHAT_DOCKER_ACTION_IDS]
})

afterAll(() => {
  for (const [key, value] of previousGlobals) {
    if (value === undefined) Reflect.deleteProperty(globalObject, key)
    else Reflect.set(globalObject, key, value)
  }
  dom.window.close()
})

describe('QuickToolbar reorder and hold drag', () => {
  test('starts pointer drag only after 500ms', async () => {
    expect(QUICK_TOOLBAR_POINTER_HOLD_MS).toBe(500)
    const held: Array<{ clientX: number; clientY: number }> = []
    const pending: Array<{ at: number; fn: () => void }> = []
    let now = 0
    const previousSetTimeout = globalThis.setTimeout
    const previousClearTimeout = globalThis.clearTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      pending.push({ at: now + Number(ms ?? 0), fn })
      return pending.length
    }) as typeof setTimeout
    globalThis.clearTimeout = ((id: number) => {
      const index = Number(id) - 1
      if (pending[index]) pending[index].fn = () => undefined
    }) as typeof clearTimeout

    const hold = createPointerHoldController((point) => { held.push(point) })
    hold.start({ clientX: 10, clientY: 12 })
    now = 499
    pending.filter((timer) => timer.at <= now).forEach((timer) => timer.fn())
    expect(held).toEqual([])
    now = 500
    pending.filter((timer) => timer.at <= now).forEach((timer) => timer.fn())
    expect(held).toEqual([{ clientX: 10, clientY: 12 }])

    globalThis.setTimeout = previousSetTimeout
    globalThis.clearTimeout = previousClearTimeout

    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    await act(async () => {
      root.render(<QuickToolbar />)
      await Promise.resolve()
    })

    const toolbar = document.querySelector('[data-component="QuickToolbar"]') as HTMLElement
    const handle = document.querySelector('[data-toolbar-drag-handle]') as HTMLElement
    toolbar.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, clientX: 4, clientY: 5 }))
    expect(startDragMock).not.toHaveBeenCalled()
    handle.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, clientX: 8, clientY: 9 }))
    expect(startDragMock).toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  test('reorders live icons after 500ms hold and does not suppress an unheld click', async () => {
    expect(nextToolbarIconOrder(CHAT_DOCKER_ACTION_IDS, 'chat.new', 'chat.manage')).toEqual([
      'chat.manage',
      'chat.new',
      ...CHAT_DOCKER_ACTION_IDS.slice(2),
    ])

    const pending: Array<{ at: number; fn: () => void }> = []
    let now = 0
    const previousSetTimeout = globalThis.setTimeout
    const previousClearTimeout = globalThis.clearTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      pending.push({ at: now + Number(ms ?? 0), fn })
      return pending.length
    }) as typeof setTimeout
    globalThis.clearTimeout = ((id: number) => {
      const index = Number(id) - 1
      if (pending[index]) pending[index].fn = () => undefined
    }) as typeof clearTimeout

    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 960 })
    document.body.append(host)
    const root: Root = createRoot(host)
    try {
      await act(async () => {
        root.render(<QuickToolbar />)
        await Promise.resolve()
      })

      const first = document.querySelector('[data-toolbar-action="chat.new"]') as HTMLElement
      const second = document.querySelector('[data-toolbar-action="chat.manage"]') as HTMLElement
      expect(first).toBeTruthy()
      expect(second).toBeTruthy()
      expect(first.hasAttribute('data-toolbar-item-drag-handle')).toBe(true)

      first.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }))
      first.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }))
      first.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      expect(actionRunMock).toHaveBeenCalled()
      expect(reorderActionsMock).not.toHaveBeenCalled()
      expect(startDragMock).not.toHaveBeenCalled()
      actionRunMock.mockClear()

      first.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, clientX: 12, clientY: 12 }))
      now = 499
      pending.filter((timer) => timer.at <= now).forEach((timer) => timer.fn())
      expect(reorderActionsMock).not.toHaveBeenCalled()
      expect(startDragMock).not.toHaveBeenCalled()
      await act(async () => {
        now = 500
        pending.filter((timer) => timer.at <= now).forEach((timer) => timer.fn())
      })
      expect(startDragMock).not.toHaveBeenCalled()
      expect(first.getAttribute('data-dragging')).toBe('')
      second.dispatchEvent(new dom.window.PointerEvent('pointermove', { bubbles: true, clientX: 40, clientY: 12 }))
      expect(reorderActionsMock).toHaveBeenCalledWith([
        'chat.manage',
        'chat.new',
        ...CHAT_DOCKER_ACTION_IDS.slice(2),
      ])
      await act(async () => {
        first.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 12 }))
        first.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(actionRunMock).not.toHaveBeenCalled()

      settings.variant = 'v2-settings-adjacent'
      settings.quickToolbarPlacement = 'chat_top_dock'
      reorderActionsMock.mockClear()
      await act(async () => {
        root.render(<QuickToolbar />)
        await Promise.resolve()
        const raf = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : typeof window.requestAnimationFrame === 'function'
            ? window.requestAnimationFrame.bind(window)
            : null
        if (raf) await new Promise<void>((resolve) => { raf(() => resolve()) })
      })
      const v2First = document.querySelector('[data-toolbar-action="chat.new"]') as HTMLElement
      const v2Second = document.querySelector('[data-toolbar-action="chat.manage"]') as HTMLElement
      expect(v2First).toBeTruthy()
      expect(v2Second).toBeTruthy()
      v2First.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, clientX: 8, clientY: 8 }))
      await act(async () => {
        now = 2000
        pending.filter((timer) => timer.at <= now).forEach((timer) => timer.fn())
      })
      expect(startDragMock).not.toHaveBeenCalled()
      expect(v2First.getAttribute('data-dragging')).toBe('')
      v2Second.dispatchEvent(new dom.window.PointerEvent('pointermove', { bubbles: true, clientX: 48, clientY: 8 }))
      expect(reorderActionsMock).toHaveBeenCalledWith([
        'chat.manage',
        'chat.new',
        ...CHAT_DOCKER_ACTION_IDS.slice(2),
      ])
    } finally {
      globalThis.setTimeout = previousSetTimeout
      globalThis.clearTimeout = previousClearTimeout
      await act(async () => root.unmount())
    }
  })

  test('every default action appears exactly once in V1 V2 and the customizer', async () => {
    const host = document.createElement('div')
    const previousBodyWidth = Object.getOwnPropertyDescriptor(document.body, 'clientWidth')
    const previousRect = dom.window.HTMLElement.prototype.getBoundingClientRect
    Object.defineProperty(document.body, 'clientWidth', { configurable: true, value: 960 })
    dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return { x: 0, y: 0, width: 40, height: 32, top: 0, left: 0, right: 40, bottom: 32, toJSON() { return this } }
    }
    document.body.append(host)
    const root: Root = createRoot(host)
    try {
      for (const variant of ['v1-free', 'v2-settings-adjacent'] as const) {
        settings.variant = variant
        await act(async () => {
          root.render(<QuickToolbar />)
          await Promise.resolve()
        })
        const rendered = [...document.querySelectorAll('[data-toolbar-action]')].map((node) => node.getAttribute('data-toolbar-action') ?? '')
        for (const id of CHAT_DOCKER_ACTION_IDS) {
          expect(countActionId(rendered.map((item) => ({ id: item })), id)).toBe(1)
        }
      }
    } finally {
      await act(async () => root.unmount())
      dom.window.HTMLElement.prototype.getBoundingClientRect = previousRect
      if (previousBodyWidth) Object.defineProperty(document.body, 'clientWidth', previousBodyWidth)
      else Reflect.deleteProperty(document.body, 'clientWidth')
    }
  })
})
