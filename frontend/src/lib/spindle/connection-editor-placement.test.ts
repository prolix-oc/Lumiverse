/// <reference types="bun-types" />

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { SpindlePlacementSlice } from '@/types/store'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalElement = globalThis.Element
const originalHTMLElement = globalThis.HTMLElement
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
})

afterAll(() => {
  Object.assign(globalThis, {
    window: originalWindow,
    document: originalDocument,
    Element: originalElement,
    HTMLElement: originalHTMLElement,
  })
})

let placementStore!: StoreApi<SpindlePlacementSlice>
const mockedUseStore = {
  getState: () => placementStore.getState(),
  setState: (...args: Parameters<StoreApi<SpindlePlacementSlice>['setState']>) => placementStore.setState(...args),
  subscribe: (...args: Parameters<StoreApi<SpindlePlacementSlice>['subscribe']>) => placementStore.subscribe(...args),
}
mock.module('@/store', () => ({ useStore: mockedUseStore }))
mock.module('./components-helper', () => ({ destroyComponentsForTarget: (_root: Element): void => {} }))
mock.module('./preset-editor-helper', () => ({
  getPresetEditorState: () => ({ open: false, presetId: null, activeTabId: null, preset: null }),
  subscribePresetEditorState: () => () => {},
  setPresetEditorActiveTab: () => {},
}))

const { createSpindlePlacementSlice } = await import('@/store/slices/spindle-placement')
const {
  createConnectionEditorTabHandle,
  destroyPlacementsForExtensionPermission,
} = await import('./placement-helper')

beforeEach(() => {
  placementStore = createStore<SpindlePlacementSlice>()(createSpindlePlacementSlice)
})

afterEach(() => {
  mock.restore()
})

describe('connection editor placement lifecycle', () => {
  test('enforces 4/32 caps through the shared placement helper', () => {
    const handles: Array<{ destroy(): void }> = []
    for (let index = 0; index < 4; index += 1) {
      handles.push(createConnectionEditorTabHandle('extension-a', { id: `owned-${index}`, title: 'Owned' }, () => {}, 1))
    }
    expect(() => createConnectionEditorTabHandle('extension-a', { id: 'owned-overflow', title: 'Overflow' }, () => {}, 1))
      .toThrow('Connection editor tab limit reached')

    for (let index = 0; index < 28; index += 1) {
      handles.push(createConnectionEditorTabHandle(`extension-${index}`, { id: `global-${index}`, title: 'Global' }, () => {}, 1))
    }
    expect(placementStore.getState().connectionEditorTabs).toHaveLength(32)
    expect(() => createConnectionEditorTabHandle('extension-overflow', { id: 'global-overflow', title: 'Overflow' }, () => {}, 1))
      .toThrow('Global connection editor tab limit reached')

    for (const handle of handles) handle.destroy()
  })

  test('removes generation-owned roots and tabs on permission teardown', () => {
    const handle = createConnectionEditorTabHandle('extension-generation', { id: 'tab', title: 'Tab' }, () => {}, 7)
    document.body.append(handle.root)

    destroyPlacementsForExtensionPermission('extension-generation', 'generation', 7)

    expect(handle.root.isConnected).toBe(false)
    expect(placementStore.getState().connectionEditorTabs).toHaveLength(0)
    expect(() => handle.setTitle('stale')).toThrow('PLACEMENT_DESTROYED')
  })
})
