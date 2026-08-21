/// <reference types="bun-types" />

import { describe, expect, test, beforeEach, mock } from 'bun:test'
import type { SpindleSlice } from '@/types/store'

/**
 * Regression coverage for the one-shot boot hydration bug:
 * "Canvas does not load until the Extensions tab is clicked".
 *
 * `loadExtensions` is triggered once by the WS CONNECTED event. A transient
 * failure of `GET /api/v1/spindle` (`spindleApi.list()`) leaves the store
 * empty, so the Canvas frontend never hydrates. The transient list fetch is
 * now retried with a bounded backoff; these tests drive the real slice with
 * mocked spindleApi/loader surfaces and assert the retry semantics.
 */

const canvasManifest = {
  version: '1.0.0',
  name: 'Canvas',
  identifier: 'canvas',
  author: 'test',
  github: 'https://example.test/canvas',
  homepage: 'https://example.test/canvas',
}

const canvasExt: import('lumiverse-spindle-types').ExtensionInfo = {
  id: 'canvas',
  identifier: 'canvas',
  name: 'Canvas',
  version: '1.0.0',
  enabled: true,
  has_frontend: true,
  has_backend: false,
  status: 'running',
  author: 'test',
  description: '',
  github: 'https://example.test/canvas',
  homepage: 'https://example.test/canvas',
  permissions: [],
  granted_permissions: [],
  installed_at: 0,
  updated_at: 0,
  metadata: {},
}

let listCalls = 0
let loadCalls = 0
let listBehavior: 'succeed' | 'throw-once' | 'always-throw' = 'succeed'

mock.module('@/api/spindle', () => ({
  spindleApi: {
    list: async () => {
      listCalls += 1
      if (listBehavior === 'always-throw' || (listBehavior === 'throw-once' && listCalls === 1)) {
        throw new Error('transient cold-start list failure')
      }
      return { extensions: [canvasExt], isPrivileged: true }
    },
    getManifest: async () => canvasManifest,
    install: async () => canvasExt,
    update: async () => canvasExt,
    switchBranch: async () => canvasExt,
    remove: async () => {},
    enable: async () => {},
    disable: async () => {},
    restart: async () => {},
    setPermissions: async () => ({ granted: [] }),
    clearManifestCache: () => {},
    updateAll: async () => ({ total: 0, completed: 0, failed: 0 }),
  },
}))

mock.module('@/lib/spindle/loader', () => ({
  loadFrontendExtension: async () => {
    loadCalls += 1
  },
  unloadFrontendExtension: async () => {},
  getLoadedExtensions: () => new Set<string>(),
}))

mock.module('@/ws/client', () => ({
  wsClient: { send: () => {} },
}))

mock.module('@/lib/spindle/browser-scheduler', () => ({
  yieldToBrowser: async () => {},
}))

const { createSpindleSlice } = await import('./spindle')

function makeSlice(): {
  state: SpindleSlice
  set: (partial: Partial<SpindleSlice> | ((s: SpindleSlice) => Partial<SpindleSlice>)) => void
  get: () => SpindleSlice
} {
  let state = {} as SpindleSlice
  const set = (partial: any) => {
    const next = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...next }
  }
  const get = () => state
  Object.assign(state, createSpindleSlice(set as any, get as any, {} as any))
  return {
    get state() {
      return state
    },
    set,
    get,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('spindle list retry', () => {
  beforeEach(() => {
    listCalls = 0
    loadCalls = 0
    listBehavior = 'succeed'
  })

  test('transient list failure is retried and extensions populate', async () => {
    listBehavior = 'throw-once'
    const slice = makeSlice()

    await slice.state.loadExtensions()

    // The second attempt (after ~1s backoff) should have succeeded
    expect(listCalls).toBe(2)
    expect(slice.get().extensions).toHaveLength(1)
    expect(slice.get().extensions[0]?.id).toBe('canvas')
    expect(slice.get().spindlePrivileged).toBe(true)
    // Hydration should have proceeded after the recovered list
    expect(loadCalls).toBe(1)
  })

  test('persisted list failure exhausts retries and leaves store empty', async () => {
    listBehavior = 'always-throw'
    const slice = makeSlice()

    await slice.state.loadExtensions()

    expect(listCalls).toBe(5)
    expect(slice.get().extensions).toHaveLength(0)
    expect(loadCalls).toBe(0)
  }, 15000)

  test('retry stops once list succeeds — no extra calls', async () => {
    listBehavior = 'throw-once'
    const slice = makeSlice()

    await slice.state.loadExtensions()
    expect(listCalls).toBe(2)

    await sleep(1500)
    // No further retries should fire after success
    expect(listCalls).toBe(2)
    expect(loadCalls).toBe(1)
  }, 10000)
})
