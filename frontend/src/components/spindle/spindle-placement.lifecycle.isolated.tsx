import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createElement, type ComponentType } from 'react'
import { createStore } from 'zustand/vanilla'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type {
  AppMountState,
  CharacterEditorTabState,
  DockPanelState,
  FloatWidgetState,
  PresetEditorTabState,
  PresetEditorToolbarItemState,
} from '@/store/slices/spindle-placement'
import { clearLiveRootsForExtension, registerLiveRoot, type LiveRootPermission } from '@/lib/spindle/live-root-registry'
import { createSpindlePlacementSlice } from '../../store/slices/spindle-placement'
import type { SpindlePlacementSlice } from '@/types/store'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['Element', globalObject.Element],
  ['HTMLElement', globalObject.HTMLElement],
  ['Node', globalObject.Node],
  ['CustomEvent', globalObject.CustomEvent],
  ['MutationObserver', globalObject.MutationObserver],
  ['requestAnimationFrame', globalObject.requestAnimationFrame],
  ['cancelAnimationFrame', globalObject.cancelAnimationFrame],
])

let nextFrameId = 0
const frames = new Map<number, FrameRequestCallback>()
const requestAnimationFrame = (callback: FrameRequestCallback): number => {
  const id = ++nextFrameId
  frames.set(id, callback)
  return id
}
const cancelAnimationFrame = (id: number): void => {
  frames.delete(id)
}
Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  CustomEvent: domWindow.CustomEvent,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame,
  cancelAnimationFrame,
})
Object.defineProperty(domWindow, 'requestAnimationFrame', { configurable: true, value: requestAnimationFrame })
Object.defineProperty(domWindow, 'cancelAnimationFrame', { configurable: true, value: cancelAnimationFrame })

const placementState = {
  spindleSettings: { dockPanelDesktopSide: 'right' as const, infoLoggingEnabled: true },
  updateDockPanel: () => {},
  unregisterDockPanel: () => {},
  updateFloatWidget: () => {},
  setPlacementHidden: () => {},
}
const useStore = Object.assign(
  <T,>(selector?: (state: typeof placementState) => T): T | typeof placementState =>
    selector ? selector(placementState) : placementState,
  { getState: () => placementState },
)
mock.module('@/store', () => ({ useStore }))
mock.module('@/hooks/useIsMobile', () => ({ default: () => false }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('@/components/shared/ContextMenu', () => ({ default: () => null }))
mock.module('@/hooks/useLongPress', () => ({ useLongPress: () => ({ onContextMenu: () => {} }) }))
mock.module('lucide-react', () => ({
  ChevronLeft: () => null,
  ChevronRight: () => null,
  ChevronUp: () => null,
  ChevronDown: () => null,
  X: () => null,
}))
mock.module('./SpindleDockPanel.module.css', () => ({ default: {} }))
mock.module('./SpindleFloatWidget.module.css', () => ({ default: {} }))

const [SpindleAppMount, SpindleCharacterEditorTabContent, SpindleDockPanel, SpindleFloatWidget, SpindlePresetEditorTabContent, SpindlePresetEditorToolbarItem] = await Promise.all([
  import('./SpindleAppMount').then((module) => module.default),
  import('./SpindleCharacterEditorTabContent').then((module) => module.default),
  import('./SpindleDockPanel').then((module) => module.default),
  import('./SpindleFloatWidget').then((module) => module.default),
  import('./SpindlePresetEditorTabContent').then((module) => module.default),
  import('./SpindlePresetEditorToolbarItem').then((module) => module.default),
])
mock.restore()

type Consumer = {
  name: string
  Component: ComponentType<any>
  props: Record<string, unknown>
  root: HTMLElement
  permission: LiveRootPermission
}

const extensionId = 'deferred-placement-extension'
const generation = 1
const mountedRoots = new Set<Root>()
const unregisterRoots: Array<() => void> = []

function runQueuedPaint(): void {
  const queued = [...frames.entries()]
  frames.clear()
  for (const [, callback] of queued) callback(0)
}

function root(id: string): HTMLElement {
  const element = document.createElement('section')
  element.id = id
  return element
}

function consumers(prefix: string): Consumer[] {
  const appRoot = root(`${prefix}-app`)
  const characterRoot = root(`${prefix}-character`)
  const dockRoot = root(`${prefix}-dock`)
  const floatRoot = root(`${prefix}-float`)
  const presetTabRoot = root(`${prefix}-preset-tab`)
  const toolbarRoot = root(`${prefix}-toolbar`)
  return [
    {
      name: 'app mount',
      Component: SpindleAppMount,
      props: {
        mount: { extensionId, root: appRoot, id: `${prefix}-app-mount`, position: 'end', visible: true } satisfies Partial<AppMountState>,
      },
      root: appRoot,
      permission: 'app_manipulation',
    },
    {
      name: 'character tab',
      Component: SpindleCharacterEditorTabContent,
      props: {
        tab: { extensionId, root: characterRoot, id: `${prefix}-character-tab`, title: 'Character' } satisfies Partial<CharacterEditorTabState>,
      },
      root: characterRoot,
      permission: 'characters',
    },
    {
      name: 'dock panel',
      Component: SpindleDockPanel,
      props: {
        panel: {
          extensionId,
          root: dockRoot,
          id: `${prefix}-dock-panel`,
          edge: 'right',
          title: 'Dock',
          size: 240,
          minSize: 120,
          maxSize: 480,
          resizable: true,
          collapsed: false,
        } satisfies Partial<DockPanelState>,
      },
      root: dockRoot,
      permission: 'ui_panels',
    },
    {
      name: 'float widget',
      Component: SpindleFloatWidget,
      props: {
        widget: {
          extensionId,
          root: floatRoot,
          id: `${prefix}-float-widget`,
          x: 20,
          y: 20,
          defaultX: 20,
          defaultY: 20,
          defaultWidth: 160,
          defaultHeight: 100,
          width: 160,
          height: 100,
          visible: true,
          snapToEdge: false,
        } satisfies Partial<FloatWidgetState>,
      },
      root: floatRoot,
      permission: 'ui_panels',
    },
    {
      name: 'preset tab',
      Component: SpindlePresetEditorTabContent,
      props: {
        tab: { extensionId, root: presetTabRoot, id: `${prefix}-preset-tab`, title: 'Preset' } satisfies Partial<PresetEditorTabState>,
      },
      root: presetTabRoot,
      permission: 'presets',
    },
    {
      name: 'preset toolbar',
      Component: SpindlePresetEditorToolbarItem,
      props: {
        item: { extensionId, root: toolbarRoot, id: `${prefix}-toolbar`, ariaLabel: 'Toolbar', visible: true } satisfies Partial<PresetEditorToolbarItemState>,
      },
      root: toolbarRoot,
      permission: 'presets',
    },
  ]
}

function renderConsumers(entries: Consumer[]): void {
  for (const entry of entries) {
    const host = document.createElement('div')
    host.dataset.consumer = entry.name
    document.body.append(host)
    const reactRoot = createRoot(host)
    flushSync(() => reactRoot.render(createElement(entry.Component, entry.props)))
    mountedRoots.add(reactRoot)
  }
}

beforeEach(() => {
  frames.clear()
  document.body.replaceChildren()
})

afterEach(() => {
  for (const reactRoot of [...mountedRoots]) {
    flushSync(() => reactRoot.unmount())
    mountedRoots.delete(reactRoot)
  }
  for (const unregister of unregisterRoots.splice(0)) unregister()
  clearLiveRootsForExtension(extensionId, generation)
  frames.clear()
  document.body.replaceChildren()
})

afterAll(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  mock.restore()
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

test('floating widget leaves child presses untouched until drag intent', () => {
  const entry = consumers('clickable').find((consumer) => consumer.name === 'float widget')!
  unregisterRoots.push(registerLiveRoot(extensionId, entry.root, entry.permission, generation))
  const button = document.createElement('button')
  button.textContent = 'Extension action'
  entry.root.append(button)
  renderConsumers([entry])
  runQueuedPaint()

  const previousComputedStyle = globalObject.getComputedStyle
  globalObject.getComputedStyle = domWindow.getComputedStyle.bind(domWindow)
  const surface = document.querySelector<HTMLElement>('[data-consumer="float widget"] > div')!
  // JSDOM has no pointer capture implementation. Real retargeting is checked
  // in the browser; here verify default behavior and the drag-end contract.
  surface.setPointerCapture = () => {}
  surface.hasPointerCapture = () => false
  let commits = 0
  const onCommit = () => { commits++ }
  window.addEventListener('spindle:float-drag-end', onCommit)
  try {
    const press = new domWindow.PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: 100, clientY: 100,
    })
    flushSync(() => button.dispatchEvent(press))
    expect(press.defaultPrevented).toBe(false)
    flushSync(() => window.dispatchEvent(new domWindow.PointerEvent('pointermove', {
      pointerId: 1, clientX: 102, clientY: 101,
    })))
    flushSync(() => window.dispatchEvent(new domWindow.PointerEvent('pointerup', {
      pointerId: 1, clientX: 102, clientY: 101,
    })))
    runQueuedPaint()
    expect(commits).toBe(0)
  } finally {
    window.removeEventListener('spindle:float-drag-end', onCommit)
    if (previousComputedStyle === undefined) delete globalObject.getComputedStyle
    else globalObject.getComputedStyle = previousComputedStyle
  }
})

test('floating widget coalesces input, preserves scaled release coordinates, and cancels pending paint on unmount', () => {
  const entry = consumers('frame-drag').find((consumer) => consumer.name === 'float widget')!
  unregisterRoots.push(registerLiveRoot(extensionId, entry.root, entry.permission, generation))
  renderConsumers([entry])
  runQueuedPaint()

  const surface = document.querySelector<HTMLElement>('[data-consumer="float widget"] > div')!
  const captured = new Set<number>()
  surface.setPointerCapture = id => { captured.add(id) }
  surface.hasPointerCapture = id => captured.has(id)
  surface.releasePointerCapture = id => { captured.delete(id) }
  const previousComputedStyle = globalObject.getComputedStyle
  globalObject.getComputedStyle = domWindow.getComputedStyle.bind(domWindow)
  document.documentElement.style.setProperty('--lumiverse-ui-scale', '1.25')
  const commits: Array<{ widgetId: string; x: number; y: number }> = []
  const onCommit = (event: Event) => commits.push((event as CustomEvent).detail)
  window.addEventListener('spindle:float-drag-end', onCommit)
  const pointer = (type: string, x: number, y: number) => flushSync(() => {
    const target = type === 'pointerdown' ? surface : window
    target.dispatchEvent(new domWindow.PointerEvent(type, {
      bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y,
    }))
  })
  try {
    pointer('pointerdown', 100, 100)
    for (let move = 1; move <= 20; move++) pointer('pointermove', 100 + move * 3, 100 + move * 2)
    expect(surface.style.transform).toBe('translate3d(20px, 20px, 0)')
    expect(frames.size).toBe(1)
    expect(commits).toEqual([])
    runQueuedPaint()
    expect(surface.style.transform).toBe('translate3d(68px, 52px, 0)')
    pointer('pointermove', 170, 140)
    pointer('pointerup', 175, 145)
    expect(surface.style.transform).toBe('translate3d(80px, 56px, 0)')
    expect(commits).toEqual([{ widgetId: (entry.props.widget as FloatWidgetState).id, x: 80, y: 56 }])
    expect(frames.size).toBe(0)
    expect(captured.size).toBe(0)

    pointer('pointerdown', 100, 100)
    pointer('pointermove', 120, 120)
    expect(frames.size).toBe(1)
    for (const reactRoot of mountedRoots) flushSync(() => reactRoot.unmount())
    mountedRoots.clear()
    expect(frames.size).toBe(0)
    expect(captured.size).toBe(0)
    pointer('pointermove', 140, 140)
    expect(frames.size).toBe(0)
    expect(commits).toHaveLength(1)
  } finally {
    window.removeEventListener('spindle:float-drag-end', onCommit)
    document.documentElement.style.removeProperty('--lumiverse-ui-scale')
    if (previousComputedStyle === undefined) delete globalObject.getComputedStyle
    else globalObject.getComputedStyle = previousComputedStyle
  }
})

test('floating widget recovers if a keyboard transition swallows the previous touch release', () => {
  const entry = consumers('keyboard-drag').find((consumer) => consumer.name === 'float widget')!
  const widget = entry.props.widget as FloatWidgetState
  unregisterRoots.push(registerLiveRoot(extensionId, entry.root, entry.permission, generation))
  renderConsumers([entry])
  runQueuedPaint()

  const surface = document.querySelector<HTMLElement>('[data-consumer="float widget"] > div')!
  const captured = new Set<number>()
  surface.setPointerCapture = (pointerId) => { captured.add(pointerId) }
  surface.hasPointerCapture = (pointerId) => captured.has(pointerId)
  surface.releasePointerCapture = (pointerId) => { captured.delete(pointerId) }
  const commits: Array<{ widgetId: string; x: number; y: number }> = []
  const onCommit = (event: Event) => commits.push((event as CustomEvent).detail)
  window.addEventListener('spindle:float-drag-end', onCommit)

  try {
    flushSync(() => surface.dispatchEvent(new domWindow.PointerEvent('pointerdown', {
      bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 100,
    })))
    flushSync(() => window.dispatchEvent(new domWindow.PointerEvent('pointermove', {
      pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 120, clientY: 100,
    })))
    expect(captured.has(1)).toBe(true)

    flushSync(() => surface.dispatchEvent(new domWindow.PointerEvent('pointerdown', {
      bubbles: true, pointerId: 3, pointerType: 'touch', isPrimary: false, button: 0, clientX: 100, clientY: 100,
    })))
    expect(captured.has(1)).toBe(true)

    flushSync(() => surface.dispatchEvent(new domWindow.PointerEvent('pointerdown', {
      bubbles: true, pointerId: 2, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 100,
    })))
    flushSync(() => window.dispatchEvent(new domWindow.PointerEvent('pointermove', {
      pointerId: 2, pointerType: 'touch', isPrimary: true, clientX: 130, clientY: 100,
    })))
    flushSync(() => window.dispatchEvent(new domWindow.PointerEvent('pointerup', {
      pointerId: 2, pointerType: 'touch', isPrimary: true, clientX: 130, clientY: 100,
    })))

    expect(captured.size).toBe(0)
    expect(commits).toEqual([{ widgetId: widget.id, x: 70, y: 20 }])
  } finally {
    window.removeEventListener('spindle:float-drag-end', onCommit)
  }
})

describe('deferred placement paint ownership', () => {
  test('attaches every registered detached root exactly once after its queued paint', () => {
    const entries = consumers('live')
    for (const entry of entries) unregisterRoots.push(registerLiveRoot(extensionId, entry.root, entry.permission, generation))

    renderConsumers(entries)
    runQueuedPaint()

    for (const entry of entries) {
      expect(document.body.contains(entry.root)).toBe(true)
    }
  })

  test('does not reattach any root unregistered before its queued paint', () => {
    const entries = consumers('stale')
    for (const entry of entries) unregisterRoots.push(registerLiveRoot(extensionId, entry.root, entry.permission, generation))

    renderConsumers(entries)
    for (const unregister of unregisterRoots.splice(0)) unregister()
    runQueuedPaint()

    for (const entry of entries) {
      const host = document.querySelector(`[data-consumer="${entry.name}"]`)
      expect(host?.contains(entry.root)).toBe(false)
      expect(entry.root.parentElement).toBeNull()
    }
  })
  test('attaches live roots once while a mixed batch leaves unregistered roots detached', () => {
    const liveEntries = consumers('mixed-live')
    const staleEntries = consumers('mixed-stale')
    const allEntries = [...liveEntries, ...staleEntries]
    for (const entry of liveEntries) unregisterRoots.push(registerLiveRoot(extensionId, entry.root, entry.permission, generation))

    const attachCounts = new Map<HTMLElement, number>()
    const originalReplaceChildren = Element.prototype.replaceChildren
    Element.prototype.replaceChildren = function (...nodes: Array<Node | string>): void {
      for (const entry of allEntries) {
        if (nodes.includes(entry.root)) attachCounts.set(entry.root, (attachCounts.get(entry.root) ?? 0) + 1)
      }
      originalReplaceChildren.call(this, ...nodes)
    }
    try {
      renderConsumers(allEntries)
      runQueuedPaint()
      for (const entry of liveEntries) {
        expect(document.body.contains(entry.root)).toBe(true)
        expect(attachCounts.get(entry.root)).toBe(1)
      }
      for (const entry of staleEntries) {
        expect(document.body.contains(entry.root)).toBe(false)
        expect(attachCounts.get(entry.root) ?? 0).toBe(0)
      }
    } finally {
      Element.prototype.replaceChildren = originalReplaceChildren
    }
  })
})

describe('drawer tab mobility cleanup', () => {
  test('clears a removed tab location and pending reset before re-registration', () => {
    const store = createStore<SpindlePlacementSlice>(createSpindlePlacementSlice)
    const extensionId = 'removed-drawer-extension'
    const tabId = 'recycled-drawer-tab'

    store.getState().registerDrawerTab({
      id: tabId,
      extensionId,
      title: 'Removed',
      badge: null,
      root: document.createElement('div'),
    })
    store.getState().moveTabTo(tabId, { kind: 'container', containerId: 'removed-container' })
    expect(store.getState().tabLocations[tabId]).toEqual({
      kind: 'container',
      containerId: 'removed-container',
    })
    expect(store.getState().pendingActiveTabReset).toBe(tabId)

    store.getState().removeAllByExtension(extensionId)

    expect(store.getState().drawerTabs).toEqual([])
    expect(store.getState().tabLocations).toEqual({})
    expect(store.getState().pendingActiveTabReset).toBeNull()

    store.getState().registerDrawerTab({
      id: tabId,
      extensionId,
      title: 'Re-registered',
      badge: null,
      root: document.createElement('div'),
    })
    expect(store.getState().tabLocations[tabId]).toBeUndefined()
    expect(store.getState().pendingActiveTabReset).toBeNull()
  })

  test('preserves another extension location and pending reset during cleanup', () => {
    const store = createStore<SpindlePlacementSlice>(createSpindlePlacementSlice)
    const removedExtensionId = 'removed-drawer-extension'
    const survivingExtensionId = 'surviving-drawer-extension'
    const removedTabId = 'removed-drawer-tab'
    const survivingTabId = 'surviving-drawer-tab'

    store.getState().registerDrawerTab({
      id: removedTabId,
      extensionId: removedExtensionId,
      title: 'Removed',
      badge: null,
      root: document.createElement('div'),
    })
    store.getState().registerDrawerTab({
      id: survivingTabId,
      extensionId: survivingExtensionId,
      title: 'Surviving',
      badge: null,
      root: document.createElement('div'),
    })

    store.getState().moveTabTo(removedTabId, { kind: 'container', containerId: 'removed-container' })
    store.getState().moveTabTo(survivingTabId, { kind: 'container', containerId: 'surviving-container' })
    expect(store.getState().pendingActiveTabReset).toBe(survivingTabId)

    store.getState().removeAllByExtension(removedExtensionId)

    expect(store.getState().drawerTabs.map((tab) => tab.id)).toEqual([survivingTabId])
    expect(store.getState().tabLocations).toEqual({
      [survivingTabId]: { kind: 'container', containerId: 'surviving-container' },
    })
    expect(store.getState().pendingActiveTabReset).toBe(survivingTabId)
  })
})
