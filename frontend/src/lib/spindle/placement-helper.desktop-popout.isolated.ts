import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { SpindlePlacementSlice } from '@/types/store'

// A native desktop pop-out is a second frontend instance whose window is sized
// from the placement catalog before the extension loads. The window the host
// creates here is 160x160, the smallest catalog entry the desktop host accepts.
const POPOUT_WINDOW_SIZE = 160
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url:
    'http://localhost/?desktopWidgetExtension=demo_extension&desktopWidgetIndex=0' +
    `&desktopWidgetTitle=Demo&desktopWidgetChromeless=1&desktopWidgetWidth=${POPOUT_WINDOW_SIZE}` +
    `&desktopWidgetHeight=${POPOUT_WINDOW_SIZE}`,
})

function sizePopoutWindow(width: number, height: number): void {
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(dom.window, 'innerHeight', { value: height, configurable: true })
}

sizePopoutWindow(POPOUT_WINDOW_SIZE, POPOUT_WINDOW_SIZE)
;(dom.window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}

const originalGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  CustomEvent: globalThis.CustomEvent,
  localStorage: globalThis.localStorage,
  getComputedStyle: globalThis.getComputedStyle,
}

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  CustomEvent: dom.window.CustomEvent,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
})

afterAll(() => {
  Object.assign(globalThis, originalGlobals)
})

// placement-helper imports the React store facade, which transitively loads
// Vite-only import.meta.glob resources. Keep this test focused on the helper by
// providing the same Zustand store API over the placement slice directly.
let placementStore!: StoreApi<SpindlePlacementSlice>
const mockedUseStore = {
  getState: () => ({ ...placementStore.getState(), spindleSettings: { infoLoggingEnabled: false } }),
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
const { createFloatWidgetHandle } = await import('./placement-helper')

const extensionId = 'desktop-popout-extension'
const generation = 3
let handles: Array<{ destroy(): void }> = []

beforeEach(() => {
  dom.window.localStorage.clear()
  placementStore = createStore<SpindlePlacementSlice>()(createSpindlePlacementSlice)
  handles = []
})

afterEach(() => {
  for (const handle of handles) handle.destroy()
  handles = []
  placementStore = createStore<SpindlePlacementSlice>()(createSpindlePlacementSlice)
})

describe('desktop pop-out float placement', () => {
  test('grows the widget past the size of the pop-out window it runs in', () => {
    const requests: Array<{ width?: unknown; height?: unknown }> = []
    const onSizeRequest = (event: Event) => requests.push((event as CustomEvent).detail)
    window.addEventListener('spindle:float-size-request', onSizeRequest)

    const handle = createFloatWidgetHandle(
      extensionId,
      { width: 112, height: 112, tooltip: 'Demo', chromeless: true },
      () => {},
      generation,
    )
    handles.push(handle)

    // The extension collapses to its compact layout first; the host mirrors
    // that size onto the native window, so the pop-out viewport shrinks with it.
    handle.setSize(112, 112)
    sizePopoutWindow(112, 112)

    // Clicking to expand asks for a widget larger than the window it lives in.
    handle.setSize(300, 420)

    expect(placementStore.getState().floatWidgets[0]).toMatchObject({ width: 300, height: 420 })
    expect(requests.at(-1)).toMatchObject({ widgetId: handle.widgetId, width: 300, height: 420 })

    window.removeEventListener('spindle:float-size-request', onSizeRequest)
  })

  test('keeps a pop-out widget inside the desktop host envelope', () => {
    const handle = createFloatWidgetHandle(
      extensionId,
      { width: 112, height: 112, chromeless: true },
      () => {},
      generation,
    )
    handles.push(handle)

    handle.setSize(4000, 4000)

    expect(placementStore.getState().floatWidgets[0]).toMatchObject({ width: 1200, height: 900 })
  })
})
