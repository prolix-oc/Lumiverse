import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { SpindlePlacementSlice } from '@/types/store'

class FakeElement extends EventTarget {
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  readonly style: Record<string, string> = {}
  isConnected = true

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child)
    child.isConnected = true
    return child
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child)
    if (index !== -1) this.children.splice(index, 1)
    child.isConnected = false
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.isConnected = false
    this.children.splice(0, this.children.length, ...children)
    for (const child of children) child.isConnected = true
  }

  contains(child: FakeElement): boolean {
    return this.children.includes(child)
  }

  remove(): void {
    this.isConnected = false
  }
}

class FakeHTMLElement extends FakeElement {}

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  clear(): void {
    this.values.clear()
  }

  keys(): string[] {
    return [...this.values.keys()]
  }
}

class FakeWindow extends EventTarget {
  innerWidth = 1600
  innerHeight = 900
  readonly localStorage = new MemoryStorage()
}

class FakeCustomEvent<T = unknown> extends Event {
  readonly detail: T

  constructor(type: string, init?: { detail?: T }) {
    super(type)
    this.detail = init?.detail as T
  }
}

const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalElement = globalThis.Element
const originalHTMLElement = globalThis.HTMLElement
const originalCustomEvent = globalThis.CustomEvent
const originalGetComputedStyle = globalThis.getComputedStyle
const originalLocalStorage = globalThis.localStorage

const fakeWindow = new FakeWindow()
let currentUiScale = 1
const fakeDocument = {
  documentElement: new FakeElement(),
  body: new FakeElement(),
  createElement: (_tagName: string) => new FakeHTMLElement(),
}

Object.assign(globalThis, {
  window: fakeWindow,
  document: fakeDocument,
  Element: FakeElement,
  HTMLElement: FakeHTMLElement,
  CustomEvent: FakeCustomEvent,
  localStorage: fakeWindow.localStorage,
  getComputedStyle: () => ({ getPropertyValue: (name: string) => name === '--lumiverse-ui-scale' ? String(currentUiScale) : '' }),
})

let placementStore!: StoreApi<SpindlePlacementSlice>
const mockedUseStore = {
  getState: () => ({
    ...placementStore.getState(),
    spindleSettings: { infoLoggingEnabled: false },
  }),
  setState: (...args: Parameters<StoreApi<SpindlePlacementSlice>['setState']>) => placementStore.setState(...args),
  subscribe: (...args: Parameters<StoreApi<SpindlePlacementSlice>['subscribe']>) => placementStore.subscribe(...args),
}

mock.module('@/store', () => ({ useStore: mockedUseStore }))
mock.module('./components-helper', () => ({ destroyComponentsForTarget: (_root: Element) => {} }))
mock.module('./preset-editor-helper', () => ({
  getPresetEditorState: () => ({ open: false, presetId: null, activeTabId: null, preset: null }),
  subscribePresetEditorState: (_handler: unknown) => () => {},
  setPresetEditorActiveTab: (_tabId: string) => {},
  setPresetEditorController: (_controller: unknown) => {},
  syncPresetEditorState: (_state: unknown) => {},
  updatePresetEditorDraft: (_mutator: unknown) => {},
  flushPresetEditorDraft: async () => {},
}))

const { createSpindlePlacementSlice } = await import('@/store/slices/spindle-placement')
const {
  createFloatWidgetHandle,
  createDockPanelHandle,
  destroyAllPlacementsForExtension,
  destroyPlacementsForExtensionPermission,
} = await import('./placement-helper')

const extensionId = 'h6-placement-extension'
const generation = 7
let handles: Array<{ destroy(): void }> = []

beforeEach(() => {
  // The slice hydrates persisted geometry during construction, so clear the
  // fake browser storage before creating each store. Reversing this order
  // carries the previous test's geometry into the new in-memory slice.
  fakeWindow.localStorage.clear()
  placementStore = createStore<SpindlePlacementSlice>()(createSpindlePlacementSlice)
  handles = []
})

afterEach(() => {
  for (const handle of handles) handle.destroy()
  handles = []
  placementStore = createStore<SpindlePlacementSlice>()(createSpindlePlacementSlice)
})

afterAll(() => {
  Object.assign(globalThis, {
    window: originalWindow,
    document: originalDocument,
    Element: originalElement,
    HTMLElement: originalHTMLElement,
    CustomEvent: originalCustomEvent,
    localStorage: originalLocalStorage,
    getComputedStyle: originalGetComputedStyle,
  })
})

describe('H6 float placement contract', () => {
  const resizeCases = [
    { edge: 'top', dx: 0, dy: 10, expected: { x: 100, y: 110, width: 100, height: 70 } },
    { edge: 'right', dx: 10, dy: 0, expected: { x: 100, y: 100, width: 110, height: 80 } },
    { edge: 'bottom', dx: 0, dy: 10, expected: { x: 100, y: 100, width: 100, height: 90 } },
    { edge: 'left', dx: 10, dy: 0, expected: { x: 110, y: 100, width: 90, height: 80 } },
    { edge: 'top-left', dx: 10, dy: 10, expected: { x: 110, y: 110, width: 90, height: 70 } },
    { edge: 'top-right', dx: 10, dy: 10, expected: { x: 100, y: 110, width: 110, height: 70 } },
    { edge: 'bottom-left', dx: 10, dy: 10, expected: { x: 110, y: 100, width: 90, height: 90 } },
    { edge: 'bottom-right', dx: 10, dy: 10, expected: { x: 100, y: 100, width: 110, height: 90 } },
  ] as const

  test.each(scalesAndEdges(resizeCases))('wires float resize edge %s at scale %s', ({ resizeCase, uiScale }) => {
    currentUiScale = uiScale
    const handle = createFloatWidgetHandle(extensionId, {
      width: 100,
      height: 80,
      initialPosition: { x: 100, y: 100 },
      bounds: { minWidth: 1, minHeight: 1, maxWidth: 300, maxHeight: 300 },
      resizable: true,
    } as any, () => {}, generation)
    handles.push(handle)
    const widget = placementStore.getState().floatWidgets[0]
    if (!widget) throw new Error('Expected float widget')
    const resizeHandle = new FakeHTMLElement()
    resizeHandle.setAttribute('data-spindle-float-resize-handle', widget.id)
    fakeWindow.dispatchEvent(new FakeCustomEvent('spindle:float-resize-handle-ready', {
      detail: { widgetId: widget.id, handle: resizeHandle, edge: resizeCase.edge },
    }))
    resizeHandle.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 1, clientX: 0, clientY: 0 }))
    fakeWindow.dispatchEvent(Object.assign(new Event('pointermove'), {
      pointerId: 1,
      clientX: resizeCase.dx * uiScale,
      clientY: resizeCase.dy * uiScale,
    }))

    expect(placementStore.getState().floatWidgets[0]).toMatchObject(resizeCase.expected)
  })

  test('keeps all eight resize controllers live and tears them down together', () => {
    const commits: Array<{ x: number; y: number; width: number; height: number }> = []
    const handle = createFloatWidgetHandle(extensionId, {
      width: 100,
      height: 80,
      initialPosition: { x: 100, y: 100 },
       bounds: { minWidth: 1, minHeight: 1, maxWidth: 300, maxHeight: 300 },
      resizable: true,
      onGeometryCommit: (rect: { x: number; y: number; width: number; height: number }) => commits.push(rect),
    } as any, () => {}, generation)
    handles.push(handle)

    const widget = placementStore.getState().floatWidgets[0]
    if (!widget) throw new Error('Expected float widget')
    const resizeHandles = resizeCases.map(({ edge }) => {
      const resizeHandle = new FakeHTMLElement()
      resizeHandle.setAttribute('data-spindle-float-resize-handle', widget.id)
      fakeWindow.dispatchEvent(new FakeCustomEvent('spindle:float-resize-handle-ready', {
        detail: { widgetId: widget.id, handle: resizeHandle, edge },
      }))
      return resizeHandle
    })

    resizeHandles.forEach((resizeHandle, index) => {
      const pointerId = index + 1
      resizeHandle.dispatchEvent(Object.assign(new Event('pointerdown'), {
        pointerId,
        clientX: 0,
        clientY: 0,
      }))
      fakeWindow.dispatchEvent(Object.assign(new Event('pointermove'), {
        pointerId,
        clientX: 4,
        clientY: 4,
      }))
      fakeWindow.dispatchEvent(Object.assign(new Event('pointerup'), {
        pointerId,
        clientX: 4,
        clientY: 4,
      }))
    })

    expect(commits).toHaveLength(8)

    handle.destroy()
    const commitsBeforeDestroy = commits.length
    resizeHandles.forEach((resizeHandle, index) => {
      const pointerId = index + 101
      resizeHandle.dispatchEvent(Object.assign(new Event('pointerdown'), {
        pointerId,
        clientX: 0,
        clientY: 0,
      }))
      fakeWindow.dispatchEvent(Object.assign(new Event('pointermove'), {
        pointerId,
        clientX: 4,
        clientY: 4,
      }))
      fakeWindow.dispatchEvent(Object.assign(new Event('pointerup'), {
        pointerId,
        clientX: 4,
        clientY: 4,
      }))
    })
    expect(commits).toHaveLength(commitsBeforeDestroy)
  })

  test('validates, clamps, namespaces, and commits persisted float geometry', () => {
    const commits: Array<{ x: number; y: number; width: number; height: number }> = []
    const handle = createFloatWidgetHandle(extensionId, {
      width: 240,
      height: 160,
      initialPosition: { x: 12, y: 18 },
      bounds: { minWidth: 1, minHeight: 1, maxWidth: 320, maxHeight: 240 },
      resizable: true,
      aspectLock: 1.5,
      persistGeometry: 'main-panel',
      mobileClamp: true,
      onGeometryCommit: (rect: { x: number; y: number; width: number; height: number }) => commits.push(rect),
    } as any, () => {}, generation)
    handles.push(handle)

    const widget = placementStore.getState().floatWidgets[0]
    expect(widget).toBeDefined()
    expect(widget?.root.getAttribute('data-spindle-extension-root')).toBe(extensionId)
    expect((widget as any)?.mobileClamp).toBe(true)

    handle.setSize(500, 500)
    expect(handle.getPosition()).toEqual({ x: 12, y: 18 })
    expect(placementStore.getState().floatWidgets[0]).toMatchObject({ x: 12, y: 18, width: 320, height: 320 / 1.5 })
    expect(commits.at(-1)).toEqual({ x: 12, y: 18, width: 320, height: 320 / 1.5 })

    handle.moveTo(-20, -30)
    expect(handle.getPosition()).toEqual({ x: 0, y: 0 })
    expect(fakeWindow.localStorage.keys()).toEqual(['spindle:placementGeometry'])
    expect(JSON.parse(fakeWindow.localStorage.getItem('spindle:placementGeometry')!)).toEqual({
      'spindle:placementGeometry:h6-placement-extension:float:main-panel': {
        x: 0,
        y: 0,
        width: 320,
        height: 320 / 1.5,
      },
    })
  })

  test('replays persisted geometry on a fresh registration and tears down cleanly', () => {
    const first = createFloatWidgetHandle(extensionId, {
      width: 100,
      height: 80,
      persistGeometry: 'replay',
    } as any, () => {}, generation)
    handles.push(first)
    first.setSize(220, 140)
    first.destroy()
    expect(placementStore.getState().floatWidgets).toHaveLength(0)

    const second = createFloatWidgetHandle(extensionId, {
      width: 80,
      height: 60,
      persistGeometry: 'replay',
    } as any, () => {}, generation + 1)
    handles.push(second)
    expect(placementStore.getState().floatWidgets[0]).toMatchObject({ width: 220, height: 140 })

    destroyAllPlacementsForExtension(extensionId, generation + 1)
    expect(placementStore.getState().floatWidgets).toHaveLength(0)
    expect(() => second.setSize(100, 100)).toThrow('PLACEMENT_DESTROYED')
  })
})

function scalesAndEdges<T extends { edge: string }>(cases: readonly T[]) {
  return [1, 1.25, 1.6].flatMap((uiScale) => cases.map((resizeCase) => ({ resizeCase, uiScale })))
}

describe('H6 dock placement contract', () => {
  test('preserves the requested edge and exposes bounded size setters', () => {
    const commits: Array<{ x: number; y: number; width: number; height: number }> = []
    const handle = createDockPanelHandle(extensionId, {
      edge: 'left',
      title: 'Panel',
      size: 240,
      minSize: 120,
      maxSize: 480,
      respectRequestedEdge: true,
      showCollapsedTitle: true,
      persistGeometry: 'dock-panel',
      onGeometryCommit: (rect: { x: number; y: number; width: number; height: number }) => commits.push(rect),
    } as any, () => {}, generation)
    handles.push(handle)

    const panel = placementStore.getState().dockPanels[0]
    expect(panel).toMatchObject({
      edge: 'left',
      size: 240,
      minSize: 120,
      maxSize: 480,
      showCollapsedTitle: true,
    })
    expect((panel as any)?.respectRequestedEdge).toBe(true)

    const extendedHandle = handle as any
    extendedHandle.setMinSize(300)
    expect(placementStore.getState().dockPanels[0]).toMatchObject({ size: 300, minSize: 300 })
    extendedHandle.setMaxSize(320)
    expect(placementStore.getState().dockPanels[0]).toMatchObject({ size: 300, maxSize: 320 })
    extendedHandle.setSize(500)
    expect(placementStore.getState().dockPanels[0]?.size).toBe(320)
    expect(commits.at(-1)).toEqual({ x: 0, y: 0, width: 320, height: 320 })

    fakeWindow.dispatchEvent(new FakeCustomEvent('spindle:dock-resize-end', {
      detail: { panelId: handle.panelId, size: 310 },
    }))
    expect(placementStore.getState().dockPanels[0]?.size).toBe(310)
    expect(commits.at(-1)).toEqual({ x: 0, y: 0, width: 310, height: 310 })
    expect(JSON.parse(fakeWindow.localStorage.getItem('spindle:placementGeometry')!)).toEqual({
      'spindle:placementGeometry:h6-placement-extension:dock:dock-panel': {
        x: 0,
        y: 0,
        width: 310,
        height: 310,
      },
    })
  })

  test('revokes only the ui-panels generation and leaves newer replay state alive', () => {
    const current = createDockPanelHandle(extensionId, {
      edge: 'right', title: 'Current', size: 240, persistGeometry: 'current',
    } as any, () => {}, generation)
    const newer = createDockPanelHandle(extensionId, {
      edge: 'right', title: 'Newer', size: 240, persistGeometry: 'newer',
    } as any, () => {}, generation + 1)
    handles.push(current, newer)

    destroyPlacementsForExtensionPermission(extensionId, 'ui_panels', generation)
    expect(placementStore.getState().dockPanels.map((panel) => panel.title)).toEqual(['Newer'])
    fakeWindow.dispatchEvent(new FakeCustomEvent('spindle:dock-resize-end', {
      detail: { panelId: current.panelId, size: 400 },
    }))
    expect(placementStore.getState().dockPanels[0]?.size).toBe(240)
    expect(() => (current as any).setSize(280)).toThrow('PLACEMENT_DESTROYED')
    ;(newer as any).setSize(280)
    expect(placementStore.getState().dockPanels[0]?.size).toBe(280)
  })
})
