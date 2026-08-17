/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createCoalescedLayoutScheduler } from './toolbarLayoutBatch'
import {
  acceptDockedV2BudgetSample,
  EMPTY_DOCK_BUDGET_STATE,
  FLOATING_V2_VIEWPORT_MARGIN,
  isFillTopDockWidth,
  isHiddenInChatTopDock,
  normalizeQuickToolbarPlacement,
  QUICK_TOOLBAR_CHILD_FLEX,
  QUICK_TOOLBAR_DOCK_ID,
  readQuickToolbarPlacement,
  resolveFloatingV2Rail,
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
  shouldHideQuickToolbarWhenOverlaid: (opts: {
    hideWhenOverlaid?: boolean
    isMobile: boolean
    modalRestoreHandle?: boolean
    settingsModalOpen?: boolean
    activeModal?: unknown
    drawerOpen?: boolean
    characterEditorOpen?: boolean
    lorebookHalfEditorOpen?: boolean
    lorebookWorkspaceOpen?: boolean
  }) => {
    const overlay = Boolean(
      opts.activeModal
      || opts.settingsModalOpen
      || opts.drawerOpen
      || opts.characterEditorOpen
      || opts.lorebookHalfEditorOpen
      || opts.lorebookWorkspaceOpen,
    )
    return overlay && ((opts.hideWhenOverlaid ?? opts.isMobile) || opts.modalRestoreHandle === true)
  },
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
  visibleTabIds: [...CHAT_DOCKER_ACTION_IDS] as string[],
  iconOrder: [...CHAT_DOCKER_ACTION_IDS] as string[],
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
  hideInChatTopDock: false,
  fillTopDockWidth: true,
  showNativeSelectMessages: true,
  opaqueToolbarBackdrop: false,
  quickToolbarPlacement: 'floating' as 'floating' | 'chat_top_dock',
}

const settings = { ...defaultSettings }

const catalogActions: Array<{
  id: string
  label: string
  description: string
  icon: (props: { size?: number }) => ReactNode
  surface: { kind: 'command' }
  run: () => undefined
}> = CHAT_DOCKER_ACTION_IDS.map((id) => ({
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

function floatingViewportPaint(width: number) {
  return `${Math.max(0, width - 2 * FLOATING_V2_VIEWPORT_MARGIN)}px`
}

function fireResizeObservers() {
  for (const observer of FakeResizeObserver.instances) {
    observer.callback([] as unknown as ResizeObserverEntry[], observer as unknown as ResizeObserver)
  }
}

function applyClientWidth(node: HTMLElement, width: number) {
  Object.defineProperty(node, 'clientWidth', { configurable: true, value: width })
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width })
  if (window.visualViewport) {
    Object.defineProperty(window.visualViewport, 'width', { configurable: true, value: width })
  }
}

afterEach(() => {
  document.body.replaceChildren()
  Object.assign(settings, defaultSettings)
  storeState.settingsModalOpen = false
  catalogActions.splice(0, catalogActions.length, ...CHAT_DOCKER_ACTION_IDS.map((id) => ({
    id,
    label: id,
    description: id,
    icon: (props: { size?: number }) => <span data-icon={id} style={{ width: props.size, height: props.size }} />,
    surface: { kind: 'command' as const },
    run: () => undefined,
  })))
  setViewportWidth(1024)
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

  test('persisted hideInChatTopDock cannot unmount QuickToolbar in dock or float', async () => {
    expect(isHiddenInChatTopDock(undefined)).toBe(false)
    expect(isHiddenInChatTopDock({})).toBe(false)
    expect(isHiddenInChatTopDock({ hideInChatTopDock: true })).toBe(true)

    settings.quickToolbarPlacement = 'chat_top_dock'
    settings.hideInChatTopDock = true
    const docked = await renderToolbar()
    expect(document.querySelector('[data-component=QuickToolbar]')).not.toBeNull()
    await act(async () => docked.root.unmount())

    settings.quickToolbarPlacement = 'floating'
    settings.hideInChatTopDock = true
    const floating = await renderToolbar()
    expect(document.querySelector('[data-component=QuickToolbar]')).not.toBeNull()
    await act(async () => floating.root.unmount())
  })

  test('acceptDockedV2BudgetSample grows immediately and needs two shrink samples', () => {
    let state = EMPTY_DOCK_BUDGET_STATE
    state = acceptDockedV2BudgetSample(400, state)
    expect(state).toEqual({ accepted: 400, pending: null, pendingCount: 0 })

    state = acceptDockedV2BudgetSample(80, state)
    expect(state).toEqual({ accepted: 400, pending: 80, pendingCount: 1 })

    state = acceptDockedV2BudgetSample(400, state)
    expect(state).toEqual({ accepted: 400, pending: null, pendingCount: 0 })

    state = acceptDockedV2BudgetSample(80, state)
    expect(state).toEqual({ accepted: 400, pending: 80, pendingCount: 1 })

    state = acceptDockedV2BudgetSample(80, state)
    expect(state).toEqual({ accepted: 80, pending: null, pendingCount: 0 })

    state = acceptDockedV2BudgetSample(1920, state)
    expect(state).toEqual({ accepted: 1920, pending: null, pendingCount: 0 })
  })

  test('acceptDockedV2BudgetSample replaces a pending shrink when delta > 1 and ignores 0/NaN', () => {
    let state = acceptDockedV2BudgetSample(400, EMPTY_DOCK_BUDGET_STATE)
    state = acceptDockedV2BudgetSample(80, state)
    expect(state).toEqual({ accepted: 400, pending: 80, pendingCount: 1 })

    state = acceptDockedV2BudgetSample(82, state)
    expect(state).toEqual({ accepted: 400, pending: 82, pendingCount: 1 })

    state = acceptDockedV2BudgetSample(82, state)
    expect(state).toEqual({ accepted: 82, pending: null, pendingCount: 0 })

    const frozen = { ...state }
    expect(acceptDockedV2BudgetSample(0, state)).toEqual(frozen)
    expect(acceptDockedV2BudgetSample(Number.NaN, state)).toEqual(frozen)
    expect(acceptDockedV2BudgetSample(Number.POSITIVE_INFINITY, state)).toEqual(frozen)
  })

  test('resolveFloatingV2Rail fill-on uses viewport margins; fill-off prefers dock then column', () => {
    const viewport = { left: 0, top: 16, width: 1920 }
    const fillOn = resolveFloatingV2Rail({ fill: true, uiScale: 1, dockRect: { left: 120, top: 40, width: 640 }, columnRect: { left: 80, top: 32, width: 800 }, viewport })
    expect(fillOn).toEqual({ x: 24, y: 16, width: 1872 })

    const fillOffDock = resolveFloatingV2Rail({ fill: false, uiScale: 1, dockRect: { left: 120, top: 40, width: 640 }, columnRect: { left: 80, top: 32, width: 800 }, viewport })
    expect(fillOffDock).toEqual({ x: 120, y: 40, width: 640 })

    const fillOffColumn = resolveFloatingV2Rail({ fill: false, uiScale: 1, dockRect: { left: 0, top: 0, width: 0 }, columnRect: { left: 80, top: 32, width: 800 }, viewport })
    expect(fillOffColumn).toEqual({ x: 80, y: 32, width: 800 })
  })

  test('preserves dock placement through reload and viewport change', async () => {
    expect(normalizeQuickToolbarPlacement(undefined)).toBe('floating')
    expect(normalizeQuickToolbarPlacement('legacy')).toBe('floating')
    expect(readQuickToolbarPlacement({})).toBe('floating')
    expect(isFillTopDockWidth(undefined)).toBe(true)
    expect(isFillTopDockWidth({})).toBe(true)
    expect(isFillTopDockWidth({ fillTopDockWidth: false })).toBe(false)
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

  test('floating V2 shows selected cards instead of staying pending on a zero budget', async () => {
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'floating'
    settings.rect = { x: 24, y: 24, width: 0, height: 0 }
    setViewportWidth(3840)
    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame

    const { root } = await renderToolbar()
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0))
    })
    const strip = document.querySelector('[data-fit]')
    expect(strip?.getAttribute('data-fit')).toBe('ready')
    const rendered = [...document.querySelectorAll('[data-toolbar-action]')].map((node) => node.getAttribute('data-toolbar-action'))
    expect(rendered).toEqual([...CHAT_DOCKER_ACTION_IDS])

    await act(async () => root.unmount())
    globalThis.requestAnimationFrame = previousRaf
  })

  test('floating V2 auto-fit shows all selected cards instead of the pinned 453 persist width', async () => {
    const extraIds = ['chat.extra-a', 'chat.extra-b', 'chat.extra-c', 'chat.extra-d'] as const
    catalogActions.push(...extraIds.map((id) => ({
      id,
      label: id,
      description: id,
      icon: (props: { size?: number }) => <span data-icon={id} style={{ width: props.size, height: props.size }} />,
      surface: { kind: 'command' as const },
      run: () => undefined,
    })))
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'floating'
    settings.autoFitBounds = true
    settings.rect = { x: 24, y: 24, width: 453, height: 32 }
    settings.visibleTabIds = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    settings.iconOrder = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    setViewportWidth(3840)

    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame

    const { root } = await renderToolbar()
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })

    const expected = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    const rendered = [...document.querySelectorAll('[data-toolbar-action]')].map((node) => node.getAttribute('data-toolbar-action'))
    expect(rendered.length).toBeGreaterThan(3)
    expect(rendered).toEqual(expected)
    const painted = (document.querySelector('[data-component="QuickToolbar"]') as HTMLElement | null)
      ?.style.getPropertyValue('--quick-toolbar-width')
    expect(painted).not.toBe('453px')
    expect(painted).toBe(floatingViewportPaint(3840))
    const rootEl = document.querySelector('[data-component="QuickToolbar"]') as HTMLElement
    expect(rootEl.style.getPropertyValue('--quick-toolbar-x')).toBe(`${FLOATING_V2_VIEWPORT_MARGIN}px`)
    expect(rootEl.style.getPropertyValue('--quick-toolbar-y')).toBe('0px')
    const rotated = document.querySelector('[style*="--quick-toolbar-rotation"]') as HTMLElement | null
    expect(rotated?.style.getPropertyValue('--quick-toolbar-rotation')).toBe('0deg')
    expect(rotated?.style.getPropertyValue('--quick-toolbar-scale')).toBe('1')

    await act(async () => root.unmount())
    globalThis.requestAnimationFrame = previousRaf
  })

  test('floating V2 auto-fit at 1920 shows all 12 selected cards instead of persist 453', async () => {
    const extraIds = ['chat.extra-a', 'chat.extra-b', 'chat.extra-c', 'chat.extra-d'] as const
    catalogActions.push(...extraIds.map((id) => ({
      id,
      label: id,
      description: id,
      icon: (props: { size?: number }) => <span data-icon={id} style={{ width: props.size, height: props.size }} />,
      surface: { kind: 'command' as const },
      run: () => undefined,
    })))
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'floating'
    settings.autoFitBounds = true
    settings.rect = { x: 24, y: 24, width: 453, height: 32 }
    settings.visibleTabIds = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    settings.iconOrder = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    setViewportWidth(1920)

    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame

    const { root } = await renderToolbar()
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })

    const expected = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    const rendered = [...document.querySelectorAll('[data-toolbar-action]')].map((node) => node.getAttribute('data-toolbar-action'))
    expect(rendered).toEqual(expected)
    expect(document.querySelector('[data-fit]')?.getAttribute('data-fit')).toBe('ready')
    const painted = (document.querySelector('[data-component="QuickToolbar"]') as HTMLElement | null)
      ?.style.getPropertyValue('--quick-toolbar-width')
    expect(painted).not.toBe('453px')
    expect(painted).toBe(floatingViewportPaint(1920))
    const rootEl = document.querySelector('[data-component="QuickToolbar"]') as HTMLElement
    expect(rootEl.style.getPropertyValue('--quick-toolbar-x')).toBe(`${FLOATING_V2_VIEWPORT_MARGIN}px`)
    expect(rootEl.style.getPropertyValue('--quick-toolbar-width')).toBe(`${1920 - 2 * FLOATING_V2_VIEWPORT_MARGIN}px`)
    const rotated = document.querySelector('[style*="--quick-toolbar-rotation"]') as HTMLElement | null
    expect(rotated?.style.getPropertyValue('--quick-toolbar-rotation')).toBe('0deg')
    expect(rotated?.style.getPropertyValue('--quick-toolbar-scale')).toBe('1')

    await act(async () => root.unmount())
    globalThis.requestAnimationFrame = previousRaf
  })

  test('floating V2 auto-fit at 700 packs a prefix and shows overflow instead of persist 453', async () => {
    const extraIds = ['chat.extra-a', 'chat.extra-b', 'chat.extra-c', 'chat.extra-d'] as const
    catalogActions.push(...extraIds.map((id) => ({
      id,
      label: id,
      description: id,
      icon: (props: { size?: number }) => <span data-icon={id} style={{ width: props.size, height: props.size }} />,
      surface: { kind: 'command' as const },
      run: () => undefined,
    })))
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'floating'
    settings.autoFitBounds = true
    // Labeled estimates (~72–190) overflow 700px; icon-only 44s would all fit.
    settings.v2IconOnly = false
    settings.v2LabelVisible = true
    settings.rect = { x: 24, y: 24, width: 453, height: 32 }
    settings.visibleTabIds = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    settings.iconOrder = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    setViewportWidth(700)

    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame

    const { root } = await renderToolbar()
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })

    const rendered = [...document.querySelectorAll('[data-toolbar-action]')]
    expect(rendered.length).toBeGreaterThanOrEqual(1)
    expect(rendered.length).toBeLessThan(12)
    expect(document.querySelector('button[aria-controls="quick-toolbar-overflow"]')).not.toBeNull()
    const painted = (document.querySelector('[data-component="QuickToolbar"]') as HTMLElement | null)
      ?.style.getPropertyValue('--quick-toolbar-width')
    expect(painted).not.toBe('453px')
    expect(painted).toBe(floatingViewportPaint(700))

    await act(async () => root.unmount())
    globalThis.requestAnimationFrame = previousRaf
  })

  test('floating V2 auto-fit fill OFF paints chat-column rail and ignores persist x/width', async () => {
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'floating'
    settings.autoFitBounds = true
    settings.fillTopDockWidth = false
    settings.rect = { x: 328, y: 90, width: 453, height: 32 }
    setViewportWidth(1920)

    const column = document.createElement('div')
    column.setAttribute('data-lumiverse-surface', 'chat-column-inner')
    const dock = document.createElement('div')
    dock.setAttribute('data-spindle-mount', 'chat_top_dock')
    column.append(dock)
    document.body.append(column)
    const rail = { left: 140, top: 48, width: 720, height: 36, right: 860, bottom: 84, x: 140, y: 48, toJSON: () => rail }
    dock.getBoundingClientRect = () => rail as DOMRect
    column.getBoundingClientRect = () => rail as DOMRect

    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame

    const { root } = await renderToolbar()
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })

    const painted = document.querySelector('[data-component="QuickToolbar"]') as HTMLElement
    expect(painted.style.getPropertyValue('--quick-toolbar-x')).toBe('140px')
    expect(painted.style.getPropertyValue('--quick-toolbar-y')).toBe('48px')
    expect(painted.style.getPropertyValue('--quick-toolbar-width')).toBe('720px')
    expect(painted.style.getPropertyValue('--quick-toolbar-width')).not.toBe('453px')
    expect(painted.style.getPropertyValue('--quick-toolbar-x')).not.toBe('328px')

    await act(async () => root.unmount())
    column.remove()
    globalThis.requestAnimationFrame = previousRaf
  })

  test('V1 persist 453 switches to floating V2 without painting 453', async () => {
    settings.variant = 'v1-free'
    settings.rect = { x: 24, y: 24, width: 453, height: 32 }
    settings.autoFitBounds = false
    settings.quickToolbarPlacement = 'floating'

    const first = await renderToolbar()
    await act(async () => first.root.unmount())

    settings.variant = 'v2-settings-adjacent'
    settings.autoFitBounds = true
    settings.quickToolbarPlacement = 'floating'

    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame

    const { root } = await renderToolbar()
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })

    const rendered = [...document.querySelectorAll('[data-toolbar-action]')].map((node) => node.getAttribute('data-toolbar-action'))
    expect(rendered).toEqual([...CHAT_DOCKER_ACTION_IDS])
    const painted = (document.querySelector('[data-component="QuickToolbar"]') as HTMLElement | null)
      ?.style.getPropertyValue('--quick-toolbar-width')
    expect(painted === 'max-content' || (painted !== '453px' && painted.endsWith('px'))).toBe(true)

    await act(async () => root.unmount())
    globalThis.requestAnimationFrame = previousRaf
  })

  test('floating V2 becomes fit-ready when Settings overlay hides', async () => {
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'floating'
    settings.hideWhenOverlaid = true
    storeState.settingsModalOpen = true
    setViewportWidth(1920)

    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    }) as typeof requestAnimationFrame

    const { root } = await renderToolbar()
    expect(document.querySelector('[data-component="QuickToolbar"]')).toBeNull()

    storeState.settingsModalOpen = false
    await act(async () => {
      root.render(<QuickToolbar />)
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })

    expect(document.querySelector('[data-fit]')?.getAttribute('data-fit')).toBe('ready')
    const rendered = [...document.querySelectorAll('[data-toolbar-action]')]
    expect(rendered.length).toBe(CHAT_DOCKER_ACTION_IDS.length)

    await act(async () => root.unmount())
    storeState.settingsModalOpen = false
    globalThis.requestAnimationFrame = previousRaf
  })

  test('floating V2 unpinned with auto-fit off packs to viewport and overflows instead of 920', async () => {
    const extraIds = ['chat.extra-a', 'chat.extra-b', 'chat.extra-c', 'chat.extra-d'] as const
    catalogActions.push(...extraIds.map((id) => ({
      id,
      label: `${id}-long-label-for-width`,
      description: id,
      icon: (props: { size?: number }) => <span data-icon={id} style={{ width: props.size, height: props.size }} />,
      surface: { kind: 'command' as const },
      run: () => undefined,
    })))
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'floating'
    settings.autoFitBounds = false
    settings.v2IconOnly = false
    settings.v2LabelVisible = true
    settings.rect = { x: 24, y: 24, width: 0, height: 0 }
    settings.visibleTabIds = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    settings.iconOrder = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    setViewportWidth(1920)

    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame

    const { root } = await renderToolbar()
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })

    const rendered = [...document.querySelectorAll('[data-toolbar-action]')]
    expect(rendered.length).toBeGreaterThanOrEqual(1)
    expect(rendered.length).toBeLessThan(12)
    expect(document.querySelector('button[aria-controls="quick-toolbar-overflow"]')).not.toBeNull()
    const painted = (document.querySelector('[data-component="QuickToolbar"]') as HTMLElement | null)
      ?.style.getPropertyValue('--quick-toolbar-width')
    expect(painted).not.toBe('920px')
    expect(painted).not.toBe('0px')
    expect(painted).not.toBe(floatingViewportPaint(1920))
    const paintedPx = Number.parseFloat(painted ?? '')
    expect(Number.isFinite(paintedPx)).toBe(true)
    expect(paintedPx).toBeLessThanOrEqual(1920 - 2 * FLOATING_V2_VIEWPORT_MARGIN)

    await act(async () => root.unmount())
    globalThis.requestAnimationFrame = previousRaf
  })

  test('floating V2 auto-fit off at a narrow viewport shows overflow instead of clipping', async () => {
    const extraIds = ['chat.extra-a', 'chat.extra-b', 'chat.extra-c', 'chat.extra-d'] as const
    catalogActions.push(...extraIds.map((id) => ({
      id,
      label: `${id}-long-label-for-width`,
      description: id,
      icon: (props: { size?: number }) => <span data-icon={id} style={{ width: props.size, height: props.size }} />,
      surface: { kind: 'command' as const },
      run: () => undefined,
    })))
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'floating'
    settings.autoFitBounds = false
    settings.v2IconOnly = false
    settings.v2LabelVisible = true
    settings.rect = { x: 24, y: 24, width: 453, height: 32 }
    settings.visibleTabIds = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    settings.iconOrder = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    setViewportWidth(700)

    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame

    const { root } = await renderToolbar()
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })

    const rendered = [...document.querySelectorAll('[data-toolbar-action]')]
    expect(rendered.length).toBeGreaterThanOrEqual(1)
    expect(rendered.length).toBeLessThan(12)
    expect(document.querySelector('button[aria-controls="quick-toolbar-overflow"]')).not.toBeNull()
    const painted = (document.querySelector('[data-component="QuickToolbar"]') as HTMLElement | null)
      ?.style.getPropertyValue('--quick-toolbar-width')
    expect(painted).not.toBe('453px')
    expect(painted).not.toBe('920px')
    expect(painted).not.toBe(floatingViewportPaint(700))
    const paintedPx = Number.parseFloat(painted ?? '')
    expect(Number.isFinite(paintedPx)).toBe(true)
    expect(paintedPx).toBeLessThanOrEqual(700 - 2 * FLOATING_V2_VIEWPORT_MARGIN)

    await act(async () => root.unmount())
    globalThis.requestAnimationFrame = previousRaf
  })

  test('docked V2 packs against remaining width after the native toolbar button', async () => {
    const extraIds = ['chat.extra-a', 'chat.extra-b', 'chat.extra-c', 'chat.extra-d'] as const
    catalogActions.push(...extraIds.map((id) => ({
      id,
      label: `${id}-long-label-for-width`,
      description: id,
      icon: (props: { size?: number }) => <span data-icon={id} style={{ width: props.size, height: props.size }} />,
      surface: { kind: 'command' as const },
      run: () => undefined,
    })))
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'chat_top_dock'
    settings.v2IconOnly = false
    settings.v2LabelVisible = true
    settings.visibleTabIds = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    settings.iconOrder = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]

    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame

    const dock = document.createElement('div')
    dock.setAttribute('data-spindle-mount', 'chat_top_dock')
    dock.setAttribute('data-dock-request', 'strip')
    dock.setAttribute('data-spindle-occupied', '')
    dock.style.display = 'flex'
    dock.style.padding = '6px 8px'
    dock.style.gap = '6px'
    const native = document.createElement('button')
    native.type = 'button'
    native.className = 'toolbarBtn'
    native.setAttribute('title', 'Select messages')
    native.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    const vacant = document.createElement('div')
    vacant.setAttribute('data-spindle-extension-root', '')
    const workspace = document.createElement('div')
    workspace.setAttribute('data-surface-id', 'quick_toolbar.workspace')
    vacant.append(workspace)
    const host = document.createElement('div')
    dock.append(native, vacant, host)
    document.body.append(dock)
    Object.defineProperty(dock, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(native, 'clientWidth', { configurable: true, value: 28 })
    Object.defineProperty(vacant, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(workspace, 'clientWidth', { configurable: true, value: 400 })

    const root: Root = createRoot(host)
    await act(async () => {
      root.render(<QuickToolbar />)
      await Promise.resolve()
    })
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })

    const rendered = [...dock.querySelectorAll('[data-toolbar-action]')]
    expect(rendered.length).toBeGreaterThanOrEqual(1)
    expect(rendered.length).toBeLessThan(12)
    expect(dock.querySelector('button[aria-controls="quick-toolbar-overflow"]')).not.toBeNull()
    expect(dock.querySelector('[data-fill-top-dock]')?.getAttribute('data-fill-top-dock')).toBe('1')
    expect(dock.contains(native)).toBe(true)
    expect(native.clientWidth).toBe(28)
    const firstCount = rendered.length
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })
    expect(dock.querySelectorAll('[data-toolbar-action]').length).toBe(firstCount)
    expect(dock.querySelectorAll('[data-toolbar-action]').length).toBeLessThan(12)

    await act(async () => root.unmount())
    dock.remove()
    globalThis.requestAnimationFrame = previousRaf
  })

  test('docked V2 leftover hysteresis accepts 400, ignores one 80, then shrinks on two 80s', async () => {
    const extraIds = ['chat.extra-a', 'chat.extra-b', 'chat.extra-c', 'chat.extra-d'] as const
    catalogActions.push(...extraIds.map((id) => ({
      id,
      label: `${id}-long-label-for-width`,
      description: id,
      icon: (props: { size?: number }) => <span data-icon={id} style={{ width: props.size, height: props.size }} />,
      surface: { kind: 'command' as const },
      run: () => undefined,
    })))
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'chat_top_dock'
    settings.v2IconOnly = false
    settings.v2LabelVisible = true
    settings.visibleTabIds = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]
    settings.iconOrder = [...CHAT_DOCKER_ACTION_IDS, ...extraIds]

    const frames: FrameRequestCallback[] = []
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame

    const dock = document.createElement('div')
    dock.setAttribute('data-spindle-mount', 'chat_top_dock')
    dock.setAttribute('data-dock-request', 'strip')
    dock.setAttribute('data-spindle-occupied', '')
    dock.style.display = 'flex'
    dock.style.padding = '6px 8px'
    dock.style.gap = '6px'
    const native = document.createElement('button')
    native.type = 'button'
    native.className = 'toolbarBtn'
    native.setAttribute('title', 'Select messages')
    native.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    const vacant = document.createElement('div')
    vacant.setAttribute('data-spindle-extension-root', '')
    const workspace = document.createElement('div')
    workspace.setAttribute('data-surface-id', 'quick_toolbar.workspace')
    vacant.append(workspace)
    const host = document.createElement('div')
    dock.append(native, vacant, host)
    document.body.append(dock)
    applyClientWidth(dock, 400)
    applyClientWidth(native, 28)
    applyClientWidth(vacant, 400)
    applyClientWidth(workspace, 400)

    const root: Root = createRoot(host)
    await act(async () => {
      root.render(<QuickToolbar />)
      await Promise.resolve()
    })
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })
    const wideCount = dock.querySelectorAll('[data-toolbar-action]').length
    expect(wideCount).toBeGreaterThanOrEqual(1)
    expect(wideCount).toBeLessThan(12)

    applyClientWidth(dock, 80)
    applyClientWidth(vacant, 80)
    applyClientWidth(workspace, 80)
    await act(async () => {
      fireResizeObservers()
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })
    expect(dock.querySelectorAll('[data-toolbar-action]').length).toBe(wideCount)

    applyClientWidth(dock, 400)
    applyClientWidth(vacant, 400)
    applyClientWidth(workspace, 400)
    await act(async () => {
      fireResizeObservers()
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })
    expect(dock.querySelectorAll('[data-toolbar-action]').length).toBe(wideCount)

    applyClientWidth(dock, 80)
    applyClientWidth(vacant, 80)
    applyClientWidth(workspace, 80)
    await act(async () => {
      fireResizeObservers()
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })
    expect(dock.querySelectorAll('[data-toolbar-action]').length).toBe(wideCount)

    await act(async () => {
      fireResizeObservers()
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })
    const shrunkCount = dock.querySelectorAll('[data-toolbar-action]').length
    expect(shrunkCount).toBeLessThan(wideCount)
    expect(dock.querySelector('button[aria-controls="quick-toolbar-overflow"]')).not.toBeNull()

    applyClientWidth(dock, 1920)
    applyClientWidth(vacant, 1920)
    applyClientWidth(workspace, 1920)
    await act(async () => {
      fireResizeObservers()
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
    })
    expect(dock.querySelectorAll('[data-toolbar-action]').length).toBeGreaterThan(shrunkCount)

    await act(async () => root.unmount())
    dock.remove()
    globalThis.requestAnimationFrame = previousRaf
  })

  test('docked V2 stays mounted under overlays with fill and native sibling space', async () => {
    settings.variant = 'v2-settings-adjacent'
    settings.quickToolbarPlacement = 'chat_top_dock'
    settings.hideWhenOverlaid = true
    settings.fillTopDockWidth = true
    storeState.settingsModalOpen = true

    const dock = document.createElement('div')
    dock.setAttribute('data-spindle-mount', 'chat_top_dock')
    dock.setAttribute('data-dock-request', 'strip')
    const native = document.createElement('button')
    native.type = 'button'
    native.className = 'toolbarBtn'
    native.setAttribute('title', 'Select messages')
    const host = document.createElement('div')
    dock.append(native, host)
    document.body.append(dock)
    applyClientWidth(dock, 400)
    applyClientWidth(native, 28)

    const root: Root = createRoot(host)
    await act(async () => {
      root.render(<QuickToolbar />)
      await Promise.resolve()
    })

    expect(document.querySelector('[data-component=QuickToolbar]')).not.toBeNull()
    expect(dock.querySelector('[data-fill-top-dock]')?.getAttribute('data-fill-top-dock')).toBe('1')
    expect(dock.contains(native)).toBe(true)
    expect(native.clientWidth).toBe(28)

    await act(async () => root.unmount())
    dock.remove()
    storeState.settingsModalOpen = false
  })
})
