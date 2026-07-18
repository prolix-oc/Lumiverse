/// <reference types="bun-types" />

import { describe, expect, test, beforeEach } from 'bun:test'
import { createSpindlePlacementSlice } from './spindle-placement'
import type { SpindlePlacementSlice } from '@/types/store'

// SpindlePlacementSlice is a Zustand slice creator. Calling it with a
// mock set/get pair exercises the slice logic without spinning up a
// real store. The slice's module-level loadHiddenPlacements() reads
// localStorage at import time; if it's missing in the test runtime
// the try/catch returns []. If present, we clear it in beforeEach
// for isolation.

function makeSlice(): {
  state: SpindlePlacementSlice
  set: (partial: SpindlePlacementSlice | ((s: SpindlePlacementSlice) => SpindlePlacementSlice | Partial<SpindlePlacementSlice>)) => void
  get: () => SpindlePlacementSlice
} {
  let state = {} as SpindlePlacementSlice
  const set = (partial: any) => {
    const next = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...next }
  }
  const get = () => state
  Object.assign(state, createSpindlePlacementSlice(set as any, get as any, {} as any))
  // `state` is reassigned inside `set`, so the returned object must
  // expose a live getter rather than a snapshot of the value.
  return {
    get state() { return state },
    set,
    get,
  }
}

describe('moveTabTo / clearPendingActiveTabReset', () => {
  let slice: ReturnType<typeof makeSlice>
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      try { localStorage.clear() } catch { /* no-op */ }
    }
    slice = makeSlice()
  })

  test('moveTabTo updates tabLocations', () => {
    slice.state.moveTabTo('profile', { kind: 'container', containerId: 'secondary-drawer' })
    expect(slice.state.tabLocations.profile).toEqual({ kind: 'container', containerId: 'secondary-drawer' })
  })

  test('moveTabTo sets pendingActiveTabReset when target is not main-drawer', () => {
    slice.state.moveTabTo('profile', { kind: 'container', containerId: 'secondary-drawer' })
    expect(slice.state.pendingActiveTabReset).toBe('profile')
  })

  test('moveTabTo does NOT set pendingActiveTabReset when target is main-drawer', () => {
    slice.state.moveTabTo('profile', { kind: 'main-drawer' })
    expect(slice.state.pendingActiveTabReset).toBeNull()
  })

  test('pendingActiveTabReset is preserved when moving another tab back to main-drawer', () => {
    slice.state.moveTabTo('profile', { kind: 'container', containerId: 'secondary-drawer' })
    slice.state.moveTabTo('connections', { kind: 'main-drawer' })
    // The "main-drawer" branch intentionally does not clear the
    // existing pending reset — that's the caller's job via
    // clearPendingActiveTabReset, which ViewportDrawer invokes after
    // picking the fallback tab.
    expect(slice.state.pendingActiveTabReset).toBe('profile')
  })

  test('clearPendingActiveTabReset clears the field', () => {
    slice.state.moveTabTo('profile', { kind: 'container', containerId: 'secondary-drawer' })
    expect(slice.state.pendingActiveTabReset).toBe('profile')
    slice.state.clearPendingActiveTabReset()
    expect(slice.state.pendingActiveTabReset).toBeNull()
  })

  test('tabLocations accumulates across multiple moves', () => {
    slice.state.moveTabTo('profile', { kind: 'container', containerId: 'secondary-drawer' })
    slice.state.moveTabTo('connections', { kind: 'container', containerId: 'secondary-drawer' })
    expect(slice.state.tabLocations).toEqual({
      profile: { kind: 'container', containerId: 'secondary-drawer' },
      connections: { kind: 'container', containerId: 'secondary-drawer' },
    })
  })

  test('moveTabTo overwrites a previous location for the same tab', () => {
    slice.state.moveTabTo('profile', { kind: 'container', containerId: 'secondary-drawer' })
    slice.state.moveTabTo('profile', { kind: 'main-drawer' })
    expect(slice.state.tabLocations.profile).toEqual({ kind: 'main-drawer' })
  })

  test('initial state has empty tabLocations and null pendingActiveTabReset', () => {
    expect(slice.state.tabLocations).toEqual({})
    expect(slice.state.pendingActiveTabReset).toBeNull()
  })

  test('moveTabTo with container kind sets pendingActiveTabReset and the value object', () => {
    slice.state.moveTabTo('profile', { kind: 'container', containerId: 'x' })
    expect(slice.state.tabLocations.profile).toEqual({ kind: 'container', containerId: 'x' })
    expect(slice.state.pendingActiveTabReset).toBe('profile')
  })
})

describe('preset editor placements', () => {
  test('registers, updates, and removes extension preset tabs', () => {
    const slice = makeSlice()
    const root = {} as HTMLElement
    slice.state.registerPresetEditorTab({ id: 'tab-1', extensionId: 'ext-1', title: 'Agent Mode', root })
    expect(slice.state.presetEditorTabs).toHaveLength(1)
    slice.state.updatePresetEditorTab('tab-1', { title: 'Agents' })
    expect(slice.state.presetEditorTabs[0].title).toBe('Agents')
    slice.state.removeAllByExtension('ext-1')
    expect(slice.state.presetEditorTabs).toHaveLength(0)
  })

  test('registers and synchronously removes extension toolbar roots', () => {
    const slice = makeSlice()
    const root = {} as HTMLElement
    slice.state.registerPresetEditorToolbarItem({
      id: 'toolbar-1',
      extensionId: 'ext-1',
      ariaLabel: 'Agent mode controls',
      root,
      visible: true,
    })
    slice.state.setPresetEditorToolbarItemVisible('toolbar-1', false)
    expect(slice.state.presetEditorToolbarItems[0].visible).toBe(false)
    slice.state.removeAllByExtension('ext-1')
    expect(slice.state.presetEditorToolbarItems).toHaveLength(0)
  })
})

describe('placement capacity', () => {
  test('allows drawer tabs from thirty distinct extensions', () => {
    const slice = makeSlice()

    for (let index = 0; index < 30; index += 1) {
      slice.state.registerDrawerTab({
        id: `tab-${index}`,
        extensionId: `extension-${index}`,
        title: `Extension ${index}`,
        badge: null,
        root: {} as HTMLElement,
      })
    }

    expect(slice.state.drawerTabs).toHaveLength(30)
  })
})

describe('hideAllPlacements / showAllPlacements', () => {
  let slice: ReturnType<typeof makeSlice>
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      try { localStorage.clear() } catch { /* no-op */ }
    }
    slice = makeSlice()
  })

  test('hideAllPlacements includes extension drawer tabs', () => {
    slice.set({
      drawerTabs: [{ id: 'drawer-1' } as any, { id: 'drawer-2' } as any],
      floatWidgets: [{ id: 'float-1' } as any],
      dockPanels: [{ id: 'dock-1' } as any],
      appMounts: [{ id: 'mount-1' } as any],
    } as any)

    slice.state.hideAllPlacements()

    expect(slice.state.hiddenPlacements).toEqual(['drawer-1', 'drawer-2', 'float-1', 'dock-1', 'mount-1'])
  })

  test('showAllPlacements clears drawer tab visibility hidden by hideAllPlacements', () => {
    slice.set({
      drawerTabs: [{ id: 'drawer-1' } as any],
      floatWidgets: [{ id: 'float-1' } as any],
    } as any)

    slice.state.hideAllPlacements()
    slice.state.showAllPlacements()

    expect(slice.state.hiddenPlacements).toEqual([])
  })
})
