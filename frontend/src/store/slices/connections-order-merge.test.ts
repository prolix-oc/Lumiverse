/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { normalizeConnectionsOrder, reorderProfiles, deriveReorderArgs } from './connections-order-merge'

describe('normalizeConnectionsOrder', () => {
  test('fills missing connection types with empty arrays', () => {
    expect(normalizeConnectionsOrder({ llm: ['a'] })).toEqual({
      llm: ['a'],
      imageGen: [],
      stt: [],
      tts: [],
    })
  })

  test('drops malformed and duplicate ids from legacy persisted values', () => {
    const out = normalizeConnectionsOrder({
      llm: ['a', 'a', '', 'b'],
      imageGen: null,
      stt: ['voice', 42],
      tts: 'not-an-array',
    } as any)
    expect(out).toEqual({
      llm: ['a', 'b'],
      imageGen: [],
      stt: ['voice'],
      tts: [],
    })
  })
})

describe('reorderProfiles', () => {
  test('reorders by id, drops unknown ids, and appends missing', () => {
    const slice = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const out = reorderProfiles(slice, ['c', 'a', 'ghost'])
    expect(out.map((p) => p.id)).toEqual(['c', 'a', 'b'])
  })

  test('appends profiles not in the order at the end', () => {
    const slice = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const out = reorderProfiles(slice, ['b'])
    expect(out.map((p) => p.id)).toEqual(['b', 'a', 'c'])
  })

  test('returns the original slice when orderedIds is undefined', () => {
    const slice = [{ id: 'a' }, { id: 'b' }]
    const out = reorderProfiles(slice, undefined)
    expect(out.map((p) => p.id)).toEqual(['a', 'b'])
  })

  test('returns the original slice when orderedIds is malformed', () => {
    const slice = [{ id: 'a' }, { id: 'b' }]
    const out = reorderProfiles(slice, null)
    expect(out.map((p) => p.id)).toEqual(['a', 'b'])
  })

  test('handles empty order array', () => {
    const slice = [{ id: 'a' }, { id: 'b' }]
    const out = reorderProfiles(slice, [])
    expect(out.map((p) => p.id)).toEqual(['a', 'b'])
  })
})

describe('deriveReorderArgs', () => {
  test('returns id arrays for slices with a matching order entry', () => {
    const out = deriveReorderArgs(
      { llm: ['b', 'a'] },
      { llm: [{ id: 'a' }, { id: 'b' }] },
    )
    expect(out.llm).toEqual(['b', 'a'])
    expect(out.imageGen).toBeUndefined()
    expect(out.stt).toBeUndefined()
    expect(out.tts).toBeUndefined()
  })

  test('skips types with no live slice', () => {
    const out = deriveReorderArgs(
      { llm: ['a'], imageGen: ['x'] },
      { llm: [{ id: 'a' }] },
    )
    expect(out.llm).toEqual(['a'])
    expect(out.imageGen).toBeUndefined()
  })

  test('skips types with no order entry', () => {
    const out = deriveReorderArgs(
      { llm: ['a'] },
      { llm: [{ id: 'a' }, { id: 'b' }], imageGen: [{ id: 'x' }] },
    )
    expect(out.llm).toEqual(['a', 'b'])
    expect(out.imageGen).toBeUndefined()
  })
})
