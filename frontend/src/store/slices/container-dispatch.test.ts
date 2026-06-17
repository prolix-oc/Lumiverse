/// <reference types="bun-types" />

import { describe, expect, test, beforeEach } from 'bun:test'
import { createSpindlePlacementSlice } from './spindle-placement'
import { createContainersSlice } from './containers'
import type { SpindlePlacementSlice } from '@/types/store'
import type { ContainersSlice } from './containers'

// Test the container dispatch logic that ContainerTabContent runs
// on every effect cycle. We test the pure store logic rather than
// rendering the component because no @testing-library/react is installed.
// HTMLElement is not available in bun's default test env, so container
// entries use plain placeholder objects — the test only exercises the
// routing and fallback logic, not actual DOM manipulation.

function makeStore() {
  let placementState = {} as SpindlePlacementSlice
  const placementSet = (partial: any) => {
    const next = typeof partial === 'function' ? partial(placementState) : partial
    placementState = { ...placementState, ...next }
  }
  const placementGet = () => placementState
  Object.assign(placementState, createSpindlePlacementSlice(placementSet as any, placementGet as any, {} as any))

  let containerState = {} as ContainersSlice
  const containerSet = (partial: any) => {
    const next = typeof partial === 'function' ? partial(containerState) : containerState
    containerState = { ...containerState, ...next }
  }
  const containerGet = () => containerState
  Object.assign(containerState, createContainersSlice(containerSet as any, containerGet as any, {} as any))

  return {
    get tabLocations() { return placementState.tabLocations },
    get containers() { return containerState.containers },
    moveTabTo: placementState.moveTabTo,
    registerContainer: containerState.registerContainer,
    unregisterContainer: containerState.unregisterContainer,
  }
}

function makeContainer(id: string, side: 'left' | 'right' = 'right') {
  // Cast to avoid HTMLElement requirement — tests only check routing, not DOM
  return { id, side, element: {} as any }
}

describe('container dispatch logic (mirrors ContainerTabContent)', () => {
  let store: ReturnType<typeof makeStore>

  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      try { localStorage.clear() } catch { /* no-op */ }
    }
    store = makeStore()
  })

  test('tabs with a registered container are not reset', () => {
    const c1 = makeContainer('my-panel')
    store.registerContainer(c1)
    store.moveTabTo('profile', { kind: 'container', containerId: 'my-panel' })

    // Simulate ContainerTabContent pass 3: fallback scan
    for (const [tabId, location] of Object.entries(store.tabLocations)) {
      if (location.kind !== 'container') continue
      if (store.containers.some((c) => c.id === location.containerId)) continue
      store.moveTabTo(tabId, { kind: 'main-drawer' })
    }

    expect(store.tabLocations.profile).toEqual({ kind: 'container', containerId: 'my-panel' })
  })

  test('tabs pointing to a missing container are reset to main-drawer', () => {
    store.moveTabTo('profile', { kind: 'container', containerId: 'nonexistent' })
    store.moveTabTo('connections', { kind: 'container', containerId: 'also-missing' })

    // Simulate ContainerTabContent pass 3: fallback scan
    for (const [tabId, location] of Object.entries(store.tabLocations)) {
      if (location.kind !== 'container') continue
      if (store.containers.some((c) => c.id === location.containerId)) continue
      store.moveTabTo(tabId, { kind: 'main-drawer' })
    }

    expect(store.tabLocations.profile).toEqual({ kind: 'main-drawer' })
    expect(store.tabLocations.connections).toEqual({ kind: 'main-drawer' })
  })

  test('container unregister triggers fallback reset', () => {
    const c1 = makeContainer('temp')
    store.registerContainer(c1)
    store.moveTabTo('profile', { kind: 'container', containerId: 'temp' })

    // Unregister the container
    store.unregisterContainer('temp')

    // Simulate the fallback scan
    for (const [tabId, location] of Object.entries(store.tabLocations)) {
      if (location.kind !== 'container') continue
      if (store.containers.some((c) => c.id === location.containerId)) continue
      store.moveTabTo(tabId, { kind: 'main-drawer' })
    }

    expect(store.tabLocations.profile).toEqual({ kind: 'main-drawer' })
  })

  test('tab with main-drawer kind is never touched by fallback', () => {
    store.moveTabTo('profile', { kind: 'main-drawer' })

    for (const [tabId, location] of Object.entries(store.tabLocations)) {
      if (location.kind !== 'container') continue
      if (store.containers.some((c) => c.id === location.containerId)) continue
      store.moveTabTo(tabId, { kind: 'main-drawer' })
    }

    expect(store.tabLocations.profile).toEqual({ kind: 'main-drawer' })
  })

  test('mixed locations: some main-drawer, some container, some missing', () => {
    const c1 = makeContainer('right-panel')
    store.registerContainer(c1)

    store.moveTabTo('profile', { kind: 'main-drawer' })
    store.moveTabTo('connections', { kind: 'container', containerId: 'right-panel' })
    store.moveTabTo('lorebook', { kind: 'container', containerId: 'nowhere' })

    // Fallback scan
    for (const [tabId, location] of Object.entries(store.tabLocations)) {
      if (location.kind !== 'container') continue
      if (store.containers.some((c) => c.id === location.containerId)) continue
      store.moveTabTo(tabId, { kind: 'main-drawer' })
    }

    expect(store.tabLocations.profile).toEqual({ kind: 'main-drawer' })
    expect(store.tabLocations.connections).toEqual({ kind: 'container', containerId: 'right-panel' })
    expect(store.tabLocations.lorebook).toEqual({ kind: 'main-drawer' })
  })

  test('container id matching finds the right container among many', () => {
    const c1 = makeContainer('a')
    const c2 = makeContainer('b')
    const c3 = makeContainer('c')
    store.registerContainer(c1)
    store.registerContainer(c2)
    store.registerContainer(c3)

    store.moveTabTo('tab-x', { kind: 'container', containerId: 'b' })

    // Find matching container
    const matched = store.containers.find((c) => {
      const loc = store.tabLocations['tab-x']
      return loc.kind === 'container' && loc.containerId === c.id
    })

    expect(matched?.id).toBe('b')
  })
})
