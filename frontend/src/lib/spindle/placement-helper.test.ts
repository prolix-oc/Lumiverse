import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { createStore, type StoreApi } from 'zustand/vanilla'
import * as presetEditorHelper from './preset-editor-helper'
import type { SpindlePresetEditorState, SpindlePresetEditorTabHandle } from './preset-editor-types'
import { createSpindlePlacementSlice } from '@/store/slices/spindle-placement'
import type { SpindlePlacementSlice } from '@/types/store'

// placement-helper imports the React store facade, which transitively loads
// Vite-only import.meta.glob resources. Keep this test focused on the helper
// by providing the same Zustand store API over the placement slice directly.
const placementStoreFactory = createStore<SpindlePlacementSlice>()
let placementStore: StoreApi<SpindlePlacementSlice> = placementStoreFactory(createSpindlePlacementSlice)
const mockedUseStore = {
  getState: () => placementStore.getState(),
  setState: (...args: Parameters<StoreApi<SpindlePlacementSlice>['setState']>) => placementStore.setState(...args),
  subscribe: (...args: Parameters<StoreApi<SpindlePlacementSlice>['subscribe']>) => placementStore.subscribe(...args),
}
mock.module('@/store', () => ({ useStore: mockedUseStore }))

// The target module must load after the narrow store facade is registered.
// This is a test-only module-loading boundary; production imports stay static.
const { createPresetEditorTabHandle } = await import('./placement-helper')

type TrackedRoot = {
  root: HTMLElement
  removed: boolean
}

const extensionId = 'placement-helper-test'
const originalCreateElement = document.createElement.bind(document)
const originalSubscribe = presetEditorHelper.subscribePresetEditorState

let createdRoots: TrackedRoot[] = []
let handles: SpindlePresetEditorTabHandle[] = []
let activeSubscriptions = 0

beforeEach(() => {
  placementStore = placementStoreFactory(createSpindlePlacementSlice)
  createdRoots = []
  handles = []
  activeSubscriptions = 0

  document.createElement = ((tagName: string) => {
    const root = originalCreateElement(tagName)
    const entry: TrackedRoot = { root, removed: false }
    root.remove = () => { entry.removed = true }
    createdRoots.push(entry)
    return root
  }) as typeof document.createElement

  spyOn(presetEditorHelper, 'subscribePresetEditorState').mockImplementation((handler: (state: SpindlePresetEditorState) => void) => {
    activeSubscriptions += 1
    const unsubscribe = originalSubscribe(handler)
    let active = true
    return () => {
      if (!active) return
      active = false
      activeSubscriptions -= 1
      unsubscribe()
    }
  })
})

afterEach(() => {
  for (const handle of handles) handle.destroy()
  placementStore = placementStoreFactory(createSpindlePlacementSlice)
  document.createElement = originalCreateElement
  mock.restore()
})

describe('preset editor tab registration', () => {
  test('unwinds state subscription and root when per-extension or global cap rejects registration', () => {
    for (let index = 0; index < 4; index += 1) {
      handles.push(createPresetEditorTabHandle(extensionId, {
        id: `per-extension-${index}`,
        title: `Per-extension ${index}`,
      }, () => {}))
    }

    expect(activeSubscriptions).toBe(4)
    expect(() => createPresetEditorTabHandle(extensionId, {
      id: 'per-extension-overflow',
      title: 'Per-extension overflow',
    }, () => {})).toThrow('Preset editor tab limit reached')
    expect(activeSubscriptions).toBe(4)
    expect(createdRoots[4]?.removed).toBe(true)
    expect(placementStore.getState().presetEditorTabs).toHaveLength(4)

    for (let index = 0; index < 4; index += 1) {
      handles.push(createPresetEditorTabHandle(`global-extension-${index}`, {
        id: `global-${index}`,
        title: `Global ${index}`,
      }, () => {}))
    }

    expect(activeSubscriptions).toBe(8)
    expect(() => createPresetEditorTabHandle('global-overflow', {
      id: 'global-overflow',
      title: 'Global overflow',
    }, () => {})).toThrow('Global preset editor tab limit reached')
    expect(activeSubscriptions).toBe(8)
    expect(createdRoots[9]?.removed).toBe(true)
    expect(placementStore.getState().presetEditorTabs).toHaveLength(8)
  })
})
