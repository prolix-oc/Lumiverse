import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type {
  SpindlePresetEditorState,
  SpindlePresetEditorTabHandle,
  SpindlePresetEditorToolbarItemHandle,
} from './preset-editor-types'
import type { SpindlePlacementSlice } from '@/types/store'

import { JSDOM } from 'jsdom'
import { clearLiveRootsForExtension } from './live-root-registry'

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
// placement-helper imports the React store facade, which transitively loads
// Vite-only import.meta.glob resources. Keep this test focused on the helper
// by providing the same Zustand store API over the placement slice directly.
let placementStore!: StoreApi<SpindlePlacementSlice>
const mockedUseStore = {
  getState: () => placementStore.getState(),
  setState: (...args: Parameters<StoreApi<SpindlePlacementSlice>['setState']>) => placementStore.setState(...args),
  subscribe: (...args: Parameters<StoreApi<SpindlePlacementSlice>['subscribe']>) => placementStore.subscribe(...args),
}
mock.module('@/store', () => ({ useStore: mockedUseStore }))
// Keep the slice behind the narrow store facade to avoid the application's
// Vite-only import.meta.glob module graph during this focused test.
const { createSpindlePlacementSlice } = await import('@/store/slices/spindle-placement')
const placementStoreFactory = createStore<SpindlePlacementSlice>()
placementStore = placementStoreFactory(createSpindlePlacementSlice)
const presetEditorHelper = {
  getPresetEditorState: (): SpindlePresetEditorState => ({
    open: false,
    presetId: null,
    activeTabId: null,
    preset: null,
  }),
  subscribePresetEditorState: (_handler: (state: SpindlePresetEditorState) => void): (() => void) => {
    activeSubscriptions += 1
    let active = true
    return () => {
      if (!active) return
      active = false
      activeSubscriptions -= 1
    }
  },
  setPresetEditorActiveTab: (_tabId: string): void => {},
  createPresetEditorScopedHelper: () => ({}),
  setPresetEditorController: (_controller: unknown): void => {},
  syncPresetEditorState: (_state: unknown): void => {},
  updatePresetEditorDraft: (_mutator: unknown): void => {},
  flushPresetEditorDraft: async (): Promise<void> => {},
}
mock.module('./components-helper', () => ({ destroyComponentsForTarget: (_root: Element): void => {} }))
mock.module('./preset-editor-helper', () => presetEditorHelper)


// The target module must load after the narrow store facade is registered.
// This is a test-only module-loading boundary; production imports stay static.
const {
  createDrawerTabHandle,
  createCharacterEditorTabHandle,
  createFloatWidgetHandle,
  createDockPanelHandle,
  createAppMountHandle,
  createInputBarActionHandle,
  clearTabMobilityHandle,
  createTabMobilityHandle,
  destroyAllPlacementsForExtension,
  createPresetEditorTabHandle,
  createPresetEditorToolbarItemHandle,
  destroyPresetEditorPlacementsForExtension,
} = await import('./placement-helper')

type TrackedRoot = {
  root: HTMLElement
  removed: boolean
}

const generation = 1

let placementHandles: Array<{ destroy(): void }> = []
const extensionId = 'placement-helper-test'
const originalCreateElement = document.createElement.bind(document)

let createdRoots: TrackedRoot[] = []
let handles: SpindlePresetEditorTabHandle[] = []
let toolbarHandles: SpindlePresetEditorToolbarItemHandle[] = []
let activeSubscriptions = 0

beforeEach(() => {
  placementStore = placementStoreFactory(createSpindlePlacementSlice)
  createdRoots = []
  handles = []
  toolbarHandles = []
  placementHandles = []

  document.createElement = ((tagName: string) => {
    const root = originalCreateElement(tagName)
    const entry: TrackedRoot = { root, removed: false }
    root.remove = () => { entry.removed = true }
    createdRoots.push(entry)
    return root
  }) as typeof document.createElement

})

afterEach(() => {
  for (const handle of toolbarHandles) handle.destroy()
  for (const handle of handles) handle.destroy()
  for (const handle of placementHandles) handle.destroy()
  for (const { root } of createdRoots) {
    const extensionId = root.getAttribute('data-spindle-extension-root')
    if (extensionId) clearLiveRootsForExtension(extensionId, generation)
  }
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
      }, () => {}, generation))
    }

    expect(activeSubscriptions).toBe(4)
    expect(() => createPresetEditorTabHandle(extensionId, {
      id: 'per-extension-overflow',
      title: 'Per-extension overflow',
    }, () => {}, generation)).toThrow('Preset editor tab limit reached')
    expect(activeSubscriptions).toBe(4)
    expect(createdRoots[4]?.removed).toBe(true)
    expect(placementStore.getState().presetEditorTabs).toHaveLength(4)

    for (let index = 0; index < 4; index += 1) {
      handles.push(createPresetEditorTabHandle(`global-extension-${index}`, {
        id: `global-${index}`,
        title: `Global ${index}`,
      }, () => {}, generation))
    }

    expect(activeSubscriptions).toBe(8)
    expect(() => createPresetEditorTabHandle('global-overflow', {
      id: 'global-overflow',
      title: 'Global overflow',
    }, () => {}, generation)).toThrow('Global preset editor tab limit reached')
    expect(activeSubscriptions).toBe(8)
    expect(createdRoots[9]?.removed).toBe(true)
    expect(placementStore.getState().presetEditorTabs).toHaveLength(8)
  })
})

describe('preset editor toolbar registration', () => {
  test('unwinds the root when per-extension or global cap rejects registration', () => {
    toolbarHandles.push(createPresetEditorToolbarItemHandle(extensionId, {
      id: 'per-extension-0',
      ariaLabel: 'Per-extension 0',
    }, () => {}, generation))

    expect(() => createPresetEditorToolbarItemHandle(extensionId, {
      id: 'per-extension-overflow',
      ariaLabel: 'Per-extension overflow',
    }, () => {}, generation)).toThrow('Preset editor toolbar item limit reached')
    expect(createdRoots[1]?.removed).toBe(true)
    expect(placementStore.getState().presetEditorToolbarItems).toHaveLength(1)

    for (let index = 0; index < 3; index += 1) {
      toolbarHandles.push(createPresetEditorToolbarItemHandle(`global-extension-${index}`, {
        id: `global-${index}`,
        ariaLabel: `Global ${index}`,
      }, () => {}, generation))
    }

    expect(() => createPresetEditorToolbarItemHandle('global-overflow', {
      id: 'global-overflow',
      ariaLabel: 'Global overflow',
    }, () => {}, generation)).toThrow('Global preset editor toolbar item limit reached')
    expect(createdRoots[5]?.removed).toBe(true)
    expect(placementStore.getState().presetEditorToolbarItems).toHaveLength(4)
  })

  test('removes revoked toolbar resources and rejects stale handle calls', () => {
    let active = true
    const handle = createPresetEditorToolbarItemHandle(extensionId, {
      id: 'revoked',
      ariaLabel: 'Revoked toolbar item',
    }, () => {
      if (!active) throw new Error('PERMISSION_DENIED:presets')
    }, generation)
    toolbarHandles.push(handle)

    handle.setVisible(false)
    expect(placementStore.getState().presetEditorToolbarItems[0]?.visible).toBe(false)
    active = false
    destroyPresetEditorPlacementsForExtension(extensionId)

    expect(createdRoots[0]?.removed).toBe(true)
    expect(placementStore.getState().presetEditorToolbarItems).toHaveLength(0)
    expect(() => handle.setVisible(true)).toThrow('PERMISSION_DENIED')
    active = true
    expect(() => handle.setVisible(true)).toThrow('PRESET_EDITOR_DESTROYED')
  })
})

describe('non-preset placement lifecycle', () => {
  test('explicit destroy is idempotent and removes its unload disposer', () => {
    const hostId = 'placement-disposer-host'
    const otherId = 'placement-disposer-other'
    const store = placementStore.getState()
    const unregisterDrawerTab = spyOn(store, 'unregisterDrawerTab')
    const unregisterCharacterEditorTab = spyOn(store, 'unregisterCharacterEditorTab')
    const unregisterFloatWidget = spyOn(store, 'unregisterFloatWidget')
    const unregisterDockPanel = spyOn(store, 'unregisterDockPanel')
    const unregisterAppMount = spyOn(store, 'unregisterAppMount')
    const unregisterInputBarAction = spyOn(store, 'unregisterInputBarAction')

    const drawer = createDrawerTabHandle(hostId, { id: 'drawer', title: 'Drawer' }, undefined, generation)
    const character = createCharacterEditorTabHandle(hostId, {
      id: 'character',
      title: 'Character',
    }, undefined, generation)
    const float = createFloatWidgetHandle(hostId, undefined, undefined, generation)
    const dock = createDockPanelHandle(hostId, {
      edge: 'left',
      title: 'Dock',
      size: 240,
    }, undefined, generation)
    const app = createAppMountHandle(hostId, undefined, undefined, generation)
    const action = createInputBarActionHandle(hostId, 'Host', {
      id: 'action',
      label: 'Action',
    }, undefined, generation)
    const otherAction = createInputBarActionHandle(otherId, 'Other', {
      id: 'action',
      label: 'Other action',
    }, undefined, generation)
    placementHandles.push(drawer, character, float, dock, app, action, otherAction)

    for (const handle of [drawer, character, float, dock, app, action]) {
      handle.destroy()
      handle.destroy()
    }

    destroyAllPlacementsForExtension(hostId)

    expect(unregisterDrawerTab).toHaveBeenCalledTimes(1)
    expect(unregisterCharacterEditorTab).toHaveBeenCalledTimes(1)
    expect(unregisterFloatWidget).toHaveBeenCalledTimes(1)
    expect(unregisterDockPanel).toHaveBeenCalledTimes(1)
    expect(unregisterAppMount).toHaveBeenCalledTimes(1)
    expect(unregisterInputBarAction).toHaveBeenCalledTimes(1)
    expect(placementStore.getState().inputBarActions).toEqual([
      expect.objectContaining({ extensionId: otherId }),
    ])
  })

  test('rejects placements registered synchronously during unload', () => {
    const hostId = 'placement-reentrant-host'
    const unregisterInputBarAction = spyOn(placementStore.getState(), 'unregisterInputBarAction')
    let reentered = false
    let registrationRejected = false
    const unsubscribe = placementStore.subscribe((state, previousState) => {
      if (reentered || previousState.inputBarActions.length === 0 || state.inputBarActions.length !== 0) return
      reentered = true
      try {
        createInputBarActionHandle(hostId, 'Reentrant', {
          id: 'reentrant',
          label: 'Reentrant action',
        }, undefined, generation)
      } catch (error) {
        registrationRejected = error instanceof Error && error.message.includes('PLACEMENT_DESTROYED')
      }
    })

    const initial = createInputBarActionHandle(hostId, 'Initial', {
      id: 'initial',
      label: 'Initial action',
    }, undefined, generation)
    placementHandles.push(initial)

    destroyAllPlacementsForExtension(hostId)
    unsubscribe()

    expect(reentered).toBe(true)
    expect(registrationRejected).toBe(true)
    expect(unregisterInputBarAction).toHaveBeenCalledTimes(1)
    expect(placementStore.getState().inputBarActions).toHaveLength(0)

    destroyAllPlacementsForExtension(hostId)
    expect(unregisterInputBarAction).toHaveBeenCalledTimes(1)
  })


  test('ignores nested unload requests while draining an extension', () => {
    const hostId = 'placement-nested-unload'
    const unregisterInputBarAction = spyOn(placementStore.getState(), 'unregisterInputBarAction')
    let nestedUnloadRequests = 0
    const unsubscribe = placementStore.subscribe((state, previousState) => {
      if (previousState.inputBarActions.length === 0 || state.inputBarActions.length !== 0) return
      nestedUnloadRequests += 1
      destroyAllPlacementsForExtension(hostId)
    })

    const handle = createInputBarActionHandle(hostId, 'Nested', {
      id: 'nested',
      label: 'Nested action',
    }, undefined, generation)
    placementHandles.push(handle)
    destroyAllPlacementsForExtension(hostId)
    unsubscribe()

    expect(nestedUnloadRequests).toBe(1)
    expect(unregisterInputBarAction).toHaveBeenCalledTimes(1)
    expect(placementStore.getState().inputBarActions).toHaveLength(0)
  })

  test('ignores recursive destroy calls while cleanup is active', () => {
    const hostId = 'placement-recursive-destroy'
    const store = placementStore.getState()
    const originalUnregister = store.unregisterInputBarAction
    let handle: { destroy(): void } | null = null
    const unregisterInputBarAction = spyOn(store, 'unregisterInputBarAction').mockImplementation((actionId) => {
      handle?.destroy()
      originalUnregister(actionId)
    })

    handle = createInputBarActionHandle(hostId, 'Recursive', {
      id: 'recursive',
      label: 'Recursive action',
    }, undefined, generation)
    placementHandles.push(handle)
    handle.destroy()

    expect(unregisterInputBarAction).toHaveBeenCalledTimes(1)
    expect(placementStore.getState().inputBarActions).toHaveLength(0)
  })
  test('rejects a placement when unload runs during registration', () => {
    const hostId = 'placement-registration-race'
    let unloading = false
    const unsubscribe = placementStore.subscribe((state, previousState) => {
      if (unloading || previousState.drawerTabs.length !== 0 || state.drawerTabs.length === 0) return
      unloading = true
      destroyAllPlacementsForExtension(hostId)
    })

    expect(() => createDrawerTabHandle(hostId, {
      id: 'registration-race',
      title: 'Registration race',
    }, undefined, generation)).toThrow('PLACEMENT_DESTROYED')
    unsubscribe()

    expect(createdRoots[0]?.removed).toBe(true)
    expect(placementStore.getState().drawerTabs).toHaveLength(0)
  })
})

describe('closed placement handles and mobility', () => {
  test('rejects non-preset handle methods after explicit destroy', () => {
    const hostId = 'placement-closed-methods'
    const drawer = createDrawerTabHandle(hostId, { id: 'drawer', title: 'Drawer' }, undefined, generation)
    const character = createCharacterEditorTabHandle(hostId, { id: 'character', title: 'Character' }, undefined, generation)
    const float = createFloatWidgetHandle(hostId, undefined, undefined, generation)
    const dock = createDockPanelHandle(hostId, { edge: 'right', title: 'Dock', size: 240 }, undefined, generation)
    const app = createAppMountHandle(hostId, undefined, undefined, generation)
    const action = createInputBarActionHandle(hostId, 'Host', { id: 'action', label: 'Action' }, undefined, generation)
    placementHandles.push(drawer, character, float, dock, app, action)

    for (const handle of placementHandles) handle.destroy()

    expect(() => drawer.setTitle('closed')).toThrow('PLACEMENT_DESTROYED')
    expect(() => character.setTitle('closed')).toThrow('PLACEMENT_DESTROYED')
    expect(() => float.moveTo(1, 1)).toThrow('PLACEMENT_DESTROYED')
    expect(() => dock.collapse()).toThrow('PLACEMENT_DESTROYED')
    expect(() => app.setVisible(false)).toThrow('PLACEMENT_DESTROYED')
    expect(() => action.setLabel('closed')).toThrow('PLACEMENT_DESTROYED')
  })

  test('retries a failed non-preset disposer while keeping the handle closed', () => {
    const hostId = 'placement-retry-cleanup'
    const store = placementStore.getState()
    const originalUnregister = store.unregisterInputBarAction
    let fail = true
    spyOn(store, 'unregisterInputBarAction').mockImplementation((actionId) => {
      if (fail) throw new Error('cleanup failed')
      originalUnregister(actionId)
    })

    const handle = createInputBarActionHandle(hostId, 'Retry', { id: 'retry', label: 'Retry' }, undefined, generation)
    placementHandles.push(handle)
    expect(() => handle.destroy()).toThrow('cleanup failed')
    expect(() => handle.setLabel('closed')).toThrow('PLACEMENT_DESTROYED')

    fail = false
    handle.destroy()
    expect(placementStore.getState().inputBarActions).toHaveLength(0)
  })

  test('invalidates already-issued tab mobility handles on clear', () => {
    const store = placementStore.getState()
    const moveTabTo = spyOn(store, 'moveTabTo')
    const handle = createTabMobilityHandle('mobility-extension')

    clearTabMobilityHandle('mobility-extension')
    handle.requestTabLocation('profile', { kind: 'main-drawer' })

    expect(moveTabTo).not.toHaveBeenCalled()
  })
})

describe('preset placement lifecycle', () => {
  test('rejects preset tab and toolbar registration races', () => {
    let tabUnloading = false
    const unsubscribeTab = placementStore.subscribe((state, previousState) => {
      if (tabUnloading || previousState.presetEditorTabs.length !== 0 || state.presetEditorTabs.length === 0) return
      tabUnloading = true
      destroyPresetEditorPlacementsForExtension('preset-tab-race')
    })
    expect(() => createPresetEditorTabHandle('preset-tab-race', {
      id: 'race',
      title: 'Race',
    }, () => {}, generation)).toThrow('PLACEMENT_DESTROYED')
    unsubscribeTab()

    let toolbarUnloading = false
    const unsubscribeToolbar = placementStore.subscribe((state, previousState) => {
      if (toolbarUnloading || previousState.presetEditorToolbarItems.length !== 0 || state.presetEditorToolbarItems.length === 0) return
      toolbarUnloading = true
      destroyPresetEditorPlacementsForExtension('preset-toolbar-race')
    })
    expect(() => createPresetEditorToolbarItemHandle('preset-toolbar-race', {
      id: 'race',
      ariaLabel: 'Race',
    }, () => {}, generation)).toThrow('PLACEMENT_DESTROYED')
    unsubscribeToolbar()

    expect(placementStore.getState().presetEditorTabs).toHaveLength(0)
    expect(placementStore.getState().presetEditorToolbarItems).toHaveLength(0)
    expect(activeSubscriptions).toBe(0)
  })

  test('rejects preset placements registered during preset cleanup', () => {
    const extensionId = 'preset-reentrant'
    let reentered = false
    let registrationRejected = false
    const unsubscribe = placementStore.subscribe((state, previousState) => {
      if (reentered || previousState.presetEditorTabs.length === 0 || state.presetEditorTabs.length !== 0) return
      reentered = true
      try {
        createPresetEditorTabHandle(extensionId, {
          id: 'reentrant',
          title: 'Reentrant',
        }, () => {}, generation)
      } catch (error) {
        registrationRejected = error instanceof Error && error.message.includes('PLACEMENT_DESTROYED')
      }
    })

    const initial = createPresetEditorTabHandle(extensionId, {
      id: 'initial',
      title: 'Initial',
    }, () => {}, generation)
    handles.push(initial)
    destroyPresetEditorPlacementsForExtension(extensionId)
    unsubscribe()

    expect(reentered).toBe(true)
    expect(registrationRejected).toBe(true)
    expect(placementStore.getState().presetEditorTabs).toHaveLength(0)
    expect(activeSubscriptions).toBe(0)
    destroyPresetEditorPlacementsForExtension(extensionId)
    expect(activeSubscriptions).toBe(0)
  })

  test('keeps preset handles closed while retrying failed cleanup', () => {
    const handle = createPresetEditorTabHandle('preset-retry', {
      id: 'retry',
      title: 'Retry',
    }, () => {}, generation)
    handles.push(handle)
    const root = createdRoots[0]?.root
    const originalRemove = root?.remove
    if (!root || !originalRemove) throw new Error('Expected preset root')
    root.remove = () => { throw new Error('preset cleanup failed') }

    expect(() => handle.destroy()).toThrow('preset cleanup failed')
    expect(() => handle.setTitle('closed')).toThrow('PRESET_EDITOR_DESTROYED')

    root.remove = originalRemove
    handle.destroy()
    expect(placementStore.getState().presetEditorTabs).toHaveLength(0)
    expect(activeSubscriptions).toBe(0)
  })
  test('rejects preset placements created by final extension cleanup', () => {
    const extensionId = 'preset-final-drain'
    let created = false
    let registrationRejected = false
    const unsubscribe = placementStore.subscribe((state, previousState) => {
      if (created || previousState.extensionCommands.length === 0 || state.extensionCommands.length !== 0) return
      created = true
      try {
        createPresetEditorToolbarItemHandle(extensionId, {
          id: 'final-drain',
          ariaLabel: 'Final drain',
        }, () => {}, generation)
      } catch (error) {
        registrationRejected = error instanceof Error && error.message.includes('PLACEMENT_DESTROYED')
      }
    })
    placementStore.setState({
      extensionCommands: [{
        extensionId,
        extensionName: 'Final drain',
        commands: [],
      }],
    })

    destroyAllPlacementsForExtension(extensionId)
    unsubscribe()

    expect(created).toBe(true)
    expect(registrationRejected).toBe(true)
    expect(placementStore.getState().presetEditorToolbarItems).toHaveLength(0)
    expect(placementStore.getState().extensionCommands).toHaveLength(0)
  })

})
