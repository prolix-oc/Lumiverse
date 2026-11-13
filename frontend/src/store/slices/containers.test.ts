/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { createContainersSlice } from './containers'
import type { ContainersSlice } from './containers'

// ContainersSlice is a Zustand slice creator. Calling it directly with
// a mock set/get pair exercises the slice logic without spinning up a
// real store (and avoids pulling the rest of the app's store graph
// into the test process).

function makeSlice(): {
  state: ContainersSlice
  set: (partial: Partial<ContainersSlice> | ((s: ContainersSlice) => Partial<ContainersSlice>)) => void
  get: () => ContainersSlice
} {
  let state = {} as ContainersSlice
  const set = (partial: Partial<ContainersSlice> | ((s: ContainersSlice) => Partial<ContainersSlice>)) => {
    const next = typeof partial === 'function' ? (partial as (s: ContainersSlice) => Partial<ContainersSlice>)(state) : partial
    state = { ...state, ...next }
  }
  const get = () => state
  Object.assign(state, createContainersSlice(set as any, get as any, {} as any))
  // `state` is reassigned inside `set`, so the returned object must
  // expose a live getter rather than a snapshot of the value.
  return {
    get state() { return state },
    set,
    get,
  }
}

function makeEntry(id: string, side: ContainersSlice['containers'][number]['side'] = 'right') {
  // The slice's container operations don't touch the DOM element, so
  // a plain object cast to HTMLElement is enough for the test.
  return { id, side, element: {} as unknown as HTMLElement }
}

describe('ContainersSlice', () => {
  test('registerContainer adds a container', () => {
    const s = makeSlice()
    s.state.registerContainer(makeEntry('c1'))
    expect(s.state.containers).toHaveLength(1)
    expect(s.state.containers[0].id).toBe('c1')
  })

  test('registerContainer replaces on id collision (idempotent)', () => {
    const s = makeSlice()
    s.state.registerContainer(makeEntry('c1', 'right'))
    s.state.registerContainer(makeEntry('c1', 'left'))
    expect(s.state.containers).toHaveLength(1)
    expect(s.state.containers[0].side).toBe('left')
  })

  test('unregisterContainer removes by id', () => {
    const s = makeSlice()
    s.state.registerContainer(makeEntry('c1'))
    s.state.registerContainer(makeEntry('c2'))
    s.state.unregisterContainer('c1')
    expect(s.state.containers).toHaveLength(1)
    expect(s.state.containers[0].id).toBe('c2')
  })

  test('unregisterContainer is a no-op for an unknown id', () => {
    const s = makeSlice()
    s.state.registerContainer(makeEntry('c1'))
    s.state.unregisterContainer('nope')
    expect(s.state.containers).toHaveLength(1)
  })

  test('getContainer returns the matching entry', () => {
    const s = makeSlice()
    const e1 = makeEntry('c1')
    s.state.registerContainer(e1)
    expect(s.state.getContainer('c1')).toBe(e1)
    expect(s.state.getContainer('nope')).toBeUndefined()
  })

  test('containers is initialized as an empty array', () => {
    const s = makeSlice()
    expect(s.state.containers).toEqual([])
  })
})
