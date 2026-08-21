import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { create } from 'zustand'

import type { PaginatedResult } from '@/types/api'
import type { RegexScript } from '@/types/regex'
import type { RegexSlice } from '@/types/store'

type ListParams = { limit?: number; offset?: number }

const listCalls: ListParams[] = []
let listImpl: (params: ListParams) => PaginatedResult<RegexScript> = () => ({
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
