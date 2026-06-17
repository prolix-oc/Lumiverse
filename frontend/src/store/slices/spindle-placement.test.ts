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
