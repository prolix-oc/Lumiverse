import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type {
  SpindlePresetEditorState,
  SpindlePresetEditorTabHandle,
  SpindlePresetEditorToolbarItemHandle,
} from './preset-editor-types'
import type { SpindlePlacementSlice } from '@/types/store'

import { JSDOM } from 'jsdom'
import { clearLiveRootsForExtension, getLiveRootRecordExact, registerLiveRoot, unregisterLiveRoot } from './live-root-registry'

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
  destroyPlacementsForExtensionPermission,
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
    for (let index = 0; index < 8; index += 1) {
      handles.push(createPresetEditorTabHandle(extensionId, {
        id: `per-extension-${index}`,
        title: `Per-extension ${index}`,
      }, () => {}, generation))
    }

    expect(activeSubscriptions).toBe(8)
    expect(() => createPresetEditorTabHandle(extensionId, {
      id: 'per-extension-overflow',
      title: 'Per-extension overflow',
    }, () => {}, generation)).toThrow('Preset editor tab limit reached')
    expect(activeSubscriptions).toBe(8)
    expect(createdRoots[8]?.removed).toBe(true)
    expect(placementStore.getState().presetEditorTabs).toHaveLength(8)

    for (let index = 0; index < 56; index += 1) {
      handles.push(createPresetEditorTabHandle(`global-extension-${index}`, {
        id: `global-${index}`,
        title: `Global ${index}`,
      }, () => {}, generation))
    }

    expect(activeSubscriptions).toBe(64)
    expect(() => createPresetEditorTabHandle('global-overflow', {
      id: 'global-overflow',
      title: 'Global overflow',
    }, () => {}, generation)).toThrow('Global preset editor tab limit reached')
    expect(activeSubscriptions).toBe(64)
    expect(createdRoots[65]?.removed).toBe(true)
    expect(placementStore.getState().presetEditorTabs).toHaveLength(64)
  })
})

describe('preset editor toolbar registration', () => {
  test('unwinds the root when per-extension or global cap rejects registration', () => {
    for (let index = 0; index < 4; index += 1) {
      toolbarHandles.push(createPresetEditorToolbarItemHandle(extensionId, {
        id: `per-extension-${index}`,
        ariaLabel: `Per-extension ${index}`,
      }, () => {}, generation))
    }

    expect(() => createPresetEditorToolbarItemHandle(extensionId, {
      id: 'per-extension-overflow',
      ariaLabel: 'Per-extension overflow',
    }, () => {}, generation)).toThrow('Preset editor toolbar item limit reached')
    expect(createdRoots[4]?.removed).toBe(true)
    expect(placementStore.getState().presetEditorToolbarItems).toHaveLength(4)

    for (let index = 0; index < 28; index += 1) {
      toolbarHandles.push(createPresetEditorToolbarItemHandle(`global-extension-${index}`, {
        id: `global-${index}`,
        ariaLabel: `Global ${index}`,
      }, () => {}, generation))
    }

    expect(() => createPresetEditorToolbarItemHandle('global-overflow', {
      id: 'global-overflow',
      ariaLabel: 'Global overflow',
    }, () => {}, generation)).toThrow('Global preset editor toolbar item limit reached')
    expect(createdRoots[33]?.removed).toBe(true)
    expect(placementStore.getState().presetEditorToolbarItems).toHaveLength(32)
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
  test('removes reparented drawer and character roots on explicit destroy', () => {
    const hostId = 'placement-reparented-explicit'
    const drawer = createDrawerTabHandle(hostId, { id: 'drawer', title: 'Drawer' }, undefined, generation)
    const character = createCharacterEditorTabHandle(hostId, {
      id: 'character',
      title: 'Character',
    }, undefined, generation)
    placementHandles.push(drawer, character)

    const container = originalCreateElement('section')
    document.body.append(container)
    for (const root of [drawer.root, character.root]) {
      container.append(root)
      const trackedRemove = root.remove
      root.remove = () => {
        trackedRemove.call(root)
        dom.window.Element.prototype.remove.call(root)
      }
    }

    drawer.destroy()
    character.destroy()

    expect(container.contains(drawer.root)).toBe(false)
    expect(container.contains(character.root)).toBe(false)
    expect(createdRoots.find((entry) => entry.root === drawer.root)?.removed).toBe(true)
    expect(createdRoots.find((entry) => entry.root === character.root)?.removed).toBe(true)
    expect(getLiveRootRecordExact(hostId, drawer.root, generation)).toBeNull()
    expect(getLiveRootRecordExact(hostId, character.root, generation)).toBeNull()
    expect(placementStore.getState().drawerTabs).toHaveLength(0)
    expect(placementStore.getState().characterEditorTabs).toHaveLength(0)
    dom.window.Element.prototype.remove.call(container)
  })

  test('permission cleanup removes reparented character roots and protects newer generations', () => {
    const hostId = 'placement-reparented-character-permission'
    const character = createCharacterEditorTabHandle(hostId, {
      id: 'character',
      title: 'Character',
    }, undefined, generation)
    placementHandles.push(character)

    const container = originalCreateElement('section')
    document.body.append(container)
    container.append(character.root)
    const trackedRemove = character.root.remove
    character.root.remove = () => {
      trackedRemove.call(character.root)
      dom.window.Element.prototype.remove.call(character.root)
    }

    destroyPlacementsForExtensionPermission(hostId, 'characters')

    expect(container.contains(character.root)).toBe(false)
    expect(createdRoots.find((entry) => entry.root === character.root)?.removed).toBe(true)
    expect(getLiveRootRecordExact(hostId, character.root, generation)).toBeNull()
    expect(placementStore.getState().characterEditorTabs).toHaveLength(0)

    const staleHostId = 'placement-reparented-character-stale'
    const staleCharacter = createCharacterEditorTabHandle(staleHostId, {
      id: 'character',
      title: 'Character',
    }, undefined, generation)
    placementHandles.push(staleCharacter)
    const newerContainer = originalCreateElement('section')
    document.body.append(newerContainer)
    newerContainer.append(staleCharacter.root)
    const staleTrackedRemove = staleCharacter.root.remove
    staleCharacter.root.remove = () => {
      staleTrackedRemove.call(staleCharacter.root)
      dom.window.Element.prototype.remove.call(staleCharacter.root)
    }
    unregisterLiveRoot(staleCharacter.root, staleHostId, generation)
    registerLiveRoot(staleHostId, staleCharacter.root, 'characters', generation + 1)

    destroyPlacementsForExtensionPermission(staleHostId, 'characters', generation)

    expect(newerContainer.contains(staleCharacter.root)).toBe(true)
    expect(createdRoots.find((entry) => entry.root === staleCharacter.root)?.removed).toBe(false)
    expect(getLiveRootRecordExact(staleHostId, staleCharacter.root, generation + 1)).not.toBeNull()
    expect(placementStore.getState().characterEditorTabs).toHaveLength(0)

    unregisterLiveRoot(staleCharacter.root, staleHostId, generation + 1)
    dom.window.Element.prototype.remove.call(staleCharacter.root)
    dom.window.Element.prototype.remove.call(container)
    dom.window.Element.prototype.remove.call(newerContainer)
  })

  test('revokes only matching privileged placements while free entries survive and same-permission reentry is blocked', () => {
    const hostId = 'placement-permission-matrix'
    const store = placementStore.getState()
    const originalUnregisterFloatWidget = store.unregisterFloatWidget
    let samePermissionReentryBlocked = false
    spyOn(store, 'unregisterFloatWidget').mockImplementation((widgetId) => {
      try {
        createFloatWidgetHandle(hostId, undefined, undefined, generation)
      } catch (error) {
        samePermissionReentryBlocked = error instanceof Error && error.message.includes('PLACEMENT_DESTROYED')
      }
      originalUnregisterFloatWidget(widgetId)
    })

    const drawer = createDrawerTabHandle(hostId, { id: 'drawer', title: 'Drawer' }, undefined, generation)
    const action = createInputBarActionHandle(hostId, 'Matrix', {
      id: 'action',
      label: 'Action',
    }, undefined, generation)
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
    const preset = createPresetEditorTabHandle(hostId, {
      id: 'preset',
      title: 'Preset',
    }, () => {}, generation)
    const toolbar = createPresetEditorToolbarItemHandle(hostId, {
      id: 'toolbar',
      ariaLabel: 'Toolbar',
    }, () => {}, generation)
    placementHandles.push(drawer, action, character, float, dock, app)
    handles.push(preset)
    toolbarHandles.push(toolbar)

    destroyPlacementsForExtensionPermission(hostId, 'ui_panels', generation)
    expect(samePermissionReentryBlocked).toBe(true)
    expect(placementStore.getState().floatWidgets).toHaveLength(0)
    expect(placementStore.getState().dockPanels).toHaveLength(0)
    expect(placementStore.getState().drawerTabs).toHaveLength(1)
    expect(placementStore.getState().inputBarActions).toHaveLength(1)
    expect(placementStore.getState().characterEditorTabs).toHaveLength(1)
    expect(placementStore.getState().appMounts).toHaveLength(1)
    expect(placementStore.getState().presetEditorTabs).toHaveLength(1)
    expect(placementStore.getState().presetEditorToolbarItems).toHaveLength(1)

    destroyPlacementsForExtensionPermission(hostId, 'app_manipulation', generation)
    expect(placementStore.getState().appMounts).toHaveLength(0)
    expect(placementStore.getState().drawerTabs).toHaveLength(1)
    expect(placementStore.getState().inputBarActions).toHaveLength(1)

    destroyPlacementsForExtensionPermission(hostId, 'characters', generation)
    expect(placementStore.getState().characterEditorTabs).toHaveLength(0)
    destroyPlacementsForExtensionPermission(hostId, 'presets', generation)
    expect(placementStore.getState().presetEditorTabs).toHaveLength(0)
    expect(placementStore.getState().presetEditorToolbarItems).toHaveLength(0)

    destroyAllPlacementsForExtension(hostId, generation)
    expect(placementStore.getState().drawerTabs).toHaveLength(0)
    expect(placementStore.getState().inputBarActions).toHaveLength(0)
  })
  test('scoped unload clears current-generation input action handlers and preserves newer actions', () => {
    const hostId = 'placement-input-action-generation'
    const current = createInputBarActionHandle(hostId, 'Current', {
      id: 'current',
      label: 'Current action',
    }, undefined, generation)
    placementHandles.push(current)
    let currentClicks = 0
    current.onClick(() => { currentClicks += 1 })
    const currentState = placementStore.getState().inputBarActions[0]
    if (!currentState) throw new Error('Expected current input action')
    expect(currentState.clickHandlers).toHaveLength(1)

    destroyAllPlacementsForExtension(hostId, generation)

    expect(currentState.clickHandlers).toHaveLength(0)
    expect(currentClicks).toBe(0)
    expect(placementStore.getState().inputBarActions).toHaveLength(0)

    const newer = createInputBarActionHandle(hostId, 'Newer', {
      id: 'newer',
      label: 'Newer action',
    }, undefined, generation + 1)
    placementHandles.push(newer)
    let newerClicks = 0
    newer.onClick(() => { newerClicks += 1 })
    const newerState = placementStore.getState().inputBarActions[0]
    if (!newerState) throw new Error('Expected newer input action')
    expect(newerState.clickHandlers).toHaveLength(1)

    destroyAllPlacementsForExtension(hostId, generation)

    expect(placementStore.getState().inputBarActions).toEqual([newerState])
    expect(newerState.clickHandlers).toHaveLength(1)
    for (const handler of newerState.clickHandlers) handler()
    expect(newerClicks).toBe(1)
  })


  test('does not remove foreign owner or newer generation roots during scoped unload', () => {
    const hostId = 'placement-scoped-unload'
    const foreignOwner = 'placement-foreign-owner'
    const foreignRoot = document.createElement('section')
    const newerRoot = document.createElement('section')
    foreignRoot.setAttribute('data-spindle-extension-root', foreignOwner)
    newerRoot.setAttribute('data-spindle-extension-root', hostId)
    registerLiveRoot(foreignOwner, foreignRoot, null, generation)
    registerLiveRoot(hostId, newerRoot, null, generation + 1)
    placementStore.getState().registerDrawerTab({
      id: 'foreign-root-state',
      extensionId: hostId,
      title: 'Foreign root',
      badge: null,
      root: foreignRoot,
    })
    placementStore.getState().registerDrawerTab({
      id: 'newer-root-state',
      extensionId: hostId,
      title: 'Newer root',
      badge: null,
      root: newerRoot,
    })

    destroyAllPlacementsForExtension(hostId, generation)

    expect(getLiveRootRecordExact(foreignOwner, foreignRoot, generation)?.root).toBe(foreignRoot)
    expect(getLiveRootRecordExact(hostId, newerRoot, generation + 1)?.root).toBe(newerRoot)
    expect(createdRoots.find((entry) => entry.root === foreignRoot)?.removed).toBe(false)
    expect(createdRoots.find((entry) => entry.root === newerRoot)?.removed).toBe(false)
    expect(placementStore.getState().drawerTabs.map((tab) => tab.id)).toEqual([
      'foreign-root-state',
      'newer-root-state',
    ])

    unregisterLiveRoot(foreignRoot, foreignOwner, generation)
    unregisterLiveRoot(newerRoot, hostId, generation + 1)
  })

  test('destroyAllPlacementsForExtension clears drawer mobility state before same-ID re-registration', () => {
    const removedExtensionId = 'destroyed-drawer-extension'
    const survivingExtensionId = 'surviving-drawer-extension'
    const placementKey = 'recycled-drawer-tab'
    const removed = createDrawerTabHandle(removedExtensionId, {
      id: placementKey,
      title: 'Removed',
    }, undefined, generation)
    const surviving = createDrawerTabHandle(survivingExtensionId, {
      id: 'surviving-drawer-tab',
      title: 'Surviving',
    }, undefined, generation)
    placementHandles.push(removed, surviving)

    const removedMobility = createTabMobilityHandle(removedExtensionId)
    const survivingMobility = createTabMobilityHandle(survivingExtensionId)
    survivingMobility.requestTabLocation(surviving.tabId, {
      kind: 'container',
      containerId: 'surviving-container',
    })
    removedMobility.requestTabLocation(removed.tabId, {
      kind: 'container',
      containerId: 'removed-container',
    })

    expect(placementStore.getState().tabLocations).toEqual({
      [surviving.tabId]: { kind: 'container', containerId: 'surviving-container' },
      [removed.tabId]: { kind: 'container', containerId: 'removed-container' },
    })
    expect(placementStore.getState().pendingActiveTabReset).toBe(removed.tabId)

    destroyAllPlacementsForExtension(removedExtensionId)

    expect(placementStore.getState().drawerTabs.map((tab) => tab.id)).toEqual([surviving.tabId])
    expect(placementStore.getState().tabLocations).toEqual({
      [surviving.tabId]: { kind: 'container', containerId: 'surviving-container' },
    })
    expect(placementStore.getState().pendingActiveTabReset).toBeNull()
    expect(createdRoots.find((entry) => entry.root === removed.root)?.removed).toBe(true)
    expect(() => removed.setTitle('closed')).toThrow('PLACEMENT_DESTROYED')

    survivingMobility.requestTabLocation(surviving.tabId, { kind: 'main-drawer' })
    expect(placementStore.getState().tabLocations[surviving.tabId]).toEqual({ kind: 'main-drawer' })

    const reRegistered = createDrawerTabHandle(removedExtensionId, {
      id: placementKey,
      title: 'Re-registered',
    }, undefined, generation)
    placementHandles.push(reRegistered)
    expect(placementStore.getState().tabLocations[reRegistered.tabId]).toBeUndefined()
    expect(placementStore.getState().pendingActiveTabReset).toBeNull()
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

  test('invalidates only the matching tab mobility generation on clear', () => {
    const store = placementStore.getState()
    const moveTabTo = spyOn(store, 'moveTabTo')
    const extensionId = 'mobility-extension'
    const stale = createTabMobilityHandle(extensionId, generation)
    const current = createTabMobilityHandle(extensionId, generation + 1)

    clearTabMobilityHandle(extensionId, generation)
    stale.requestTabLocation('profile', { kind: 'main-drawer' })
    current.requestTabLocation('profile', { kind: 'main-drawer' })
    expect(moveTabTo).toHaveBeenCalledTimes(1)

    clearTabMobilityHandle(extensionId, generation + 1)
    current.requestTabLocation('profile', { kind: 'main-drawer' })
    expect(moveTabTo).toHaveBeenCalledTimes(1)
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
