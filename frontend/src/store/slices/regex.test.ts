import { afterEach, beforeAll, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import { create } from 'zustand'
import { createRegexRefreshScheduler } from '@/ws/regex-refresh'

import type { PaginatedResult } from '@/types/api'
import type { RegexScript } from '@/types/regex'
import type { RegexSlice } from '@/types/store'

type ListParams = { limit?: number; offset?: number }

const listCalls: ListParams[] = []
let listImpl: (params: ListParams) => PaginatedResult<RegexScript> | Promise<PaginatedResult<RegexScript>> = () => ({
  data: [],
  total: 0,
  limit: 0,
  offset: 0,
})

mock.module('@/api/regex', () => ({
  regexApi: {
    list: (params?: ListParams) => {
      listCalls.push(params ?? {})
      return Promise.resolve(listImpl(params ?? {}))
    },
  },
}))

let createRegexSlice: typeof import('./regex').createRegexSlice

beforeAll(async () => {
  ;({ createRegexSlice } = await import('./regex'))
})

function makeScript(index: number): RegexScript {
  return { id: `script-${index}` } as unknown as RegexScript
}

function pageOf(scripts: RegexScript[], params: ListParams): PaginatedResult<RegexScript> {
  const limit = params.limit ?? 1000
  const offset = params.offset ?? 0
  return { data: scripts.slice(offset, offset + limit), total: scripts.length, limit, offset }
}

describe('loadRegexScripts pagination', () => {
  beforeEach(() => {
    listCalls.length = 0
  })

  test('pages past the 1000-row server cap until the list is exhausted', async () => {
    const scripts = Array.from({ length: 2500 }, (_, i) => makeScript(i))
    listImpl = (params) => pageOf(scripts, params)

    const store = create<RegexSlice>()(createRegexSlice)
    await store.getState().loadRegexScripts()

    expect(listCalls).toEqual([
      { limit: 1000, offset: 0 },
      { limit: 1000, offset: 1000 },
      { limit: 1000, offset: 2000 },
    ])
    const loaded = store.getState().regexScripts
    expect(loaded).toHaveLength(2500)
    expect(loaded[0]?.id).toBe('script-0')
    expect(loaded[2499]?.id).toBe('script-2499')
  })

  test('stops after a single page when everything fits', async () => {
    const scripts = Array.from({ length: 12 }, (_, i) => makeScript(i))
    listImpl = (params) => pageOf(scripts, params)

    const store = create<RegexSlice>()(createRegexSlice)
    await store.getState().loadRegexScripts()

    expect(listCalls).toEqual([{ limit: 1000, offset: 0 }])
    expect(store.getState().regexScripts).toHaveLength(12)
  })

  test('does not clobber the store when shouldApply returns false', async () => {
    const scripts = Array.from({ length: 5 }, (_, i) => makeScript(i))
    listImpl = (params) => pageOf(scripts, params)

    const store = create<RegexSlice>()(createRegexSlice)
    const existing = makeScript(999)
    store.setState({ regexScripts: [existing] })
    await store.getState().loadRegexScripts(() => false)

    expect(listCalls).toEqual([{ limit: 1000, offset: 0 }])
    expect(store.getState().regexScripts).toEqual([existing])
  })
})

describe('regex notification refreshes', () => {
  let scheduler: ReturnType<typeof createRegexRefreshScheduler>

  beforeEach(() => {
    listCalls.length = 0
    jest.useFakeTimers()
  })

  afterEach(() => {
    scheduler?.dispose()
    jest.useRealTimers()
  })

  function setup() {
    const store = create<RegexSlice>()(createRegexSlice)
    const applied = jest.fn()
    store.subscribe(applied)
    scheduler = createRegexRefreshScheduler((shouldApply) => store.getState().loadRegexScripts(shouldApply))
    return { store, applied }
  }

  async function settle() {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }

  test('584 notifications share one library fetch and one state update', async () => {
    const scripts = Array.from({ length: 584 }, (_, i) => makeScript(i))
    listImpl = (params) => pageOf(scripts, params)
    const { store, applied } = setup()

    // Separate WS callbacks can span multiple event-loop turns.
    for (let i = 0; i < 584; i++) {
      scheduler.request()
      jest.advanceTimersByTime(1)
    }
    expect(listCalls).toHaveLength(0)
    jest.advanceTimersByTime(75)
    await settle()

    expect(listCalls).toHaveLength(1)
    expect(applied).toHaveBeenCalledTimes(1)
    expect(store.getState().regexScripts).toEqual(scripts)
  })

  test('a coalesced refresh still loads every server page and applies once', async () => {
    const scripts = Array.from({ length: 2500 }, (_, i) => makeScript(i))
    listImpl = (params) => pageOf(scripts, params)
    const { store, applied } = setup()
    scheduler.request()
    scheduler.request()
    jest.advanceTimersByTime(75)
    await settle()

    expect(listCalls.map((params) => params.offset)).toEqual([0, 1000, 2000])
    expect(applied).toHaveBeenCalledTimes(1)
    expect(store.getState().regexScripts).toHaveLength(2500)
  })

  test('changes during a fetch discard its stale snapshot and schedule one follow-up', async () => {
    let finish!: (page: PaginatedResult<RegexScript>) => void
    listImpl = () => new Promise((resolve) => { finish = resolve })
    const { store, applied } = setup()
    scheduler.request()
    jest.advanceTimersByTime(75)

    for (let i = 0; i < 584; i++) scheduler.request()
    jest.advanceTimersByTime(500)
    expect(listCalls).toHaveLength(1) // no parallel fetch
    finish(pageOf([makeScript(0)], {}))
    await settle()
    expect(applied).not.toHaveBeenCalled()

    const latest = [makeScript(1)]
    listImpl = (params) => pageOf(latest, params)
    jest.advanceTimersByTime(75)
    await settle()
    expect(listCalls).toHaveLength(2)
    expect(applied).toHaveBeenCalledTimes(1)
    expect(store.getState().regexScripts).toEqual(latest)
  })

  test('cleanup cancels queued refreshes and ignores responses after logout', async () => {
    setup()
    scheduler.request()
    scheduler.dispose()
    jest.advanceTimersByTime(75)
    expect(listCalls).toHaveLength(0)

    let finish!: (page: PaginatedResult<RegexScript>) => void
    listImpl = () => new Promise((resolve) => { finish = resolve })
    const { applied } = setup()
    scheduler.request()
    jest.advanceTimersByTime(75)
    scheduler.dispose()
    finish(pageOf([makeScript(0)], {}))
    await settle()
    expect(applied).not.toHaveBeenCalled()
  })

  test('a failed background reload does not prevent the next change from refreshing', async () => {
    listImpl = () => { throw new Error('offline') }
    const { applied } = setup()
    scheduler.request()
    jest.advanceTimersByTime(75)
    await settle()
    expect(applied).not.toHaveBeenCalled()

    listImpl = (params) => pageOf([makeScript(1)], params)
    scheduler.request()
    jest.advanceTimersByTime(75)
    await settle()
    expect(applied).toHaveBeenCalledTimes(1)
  })
})
