import { describe, expect, test } from 'bun:test'
import { loadLorebookSearchEntries } from './loadLorebookSearchEntries'

describe('complete lorebook search source', () => {
  test('walks every page and accepts an empty scope', async () => {
    const rows = Array.from({ length: 2001 }, (_, id) => ({ id }))
    const offsets: number[] = []
    const result = await loadLorebookSearchEntries(async ({ limit, offset }) => {
      offsets.push(offset)
      return { data: rows.slice(offset, offset + limit), total: rows.length }
    }, new AbortController().signal)
    expect(result).toEqual(rows)
    expect(offsets).toEqual([0, 1000, 2000])
    expect(await loadLorebookSearchEntries(async () => ({ data: [], total: 0 }), new AbortController().signal)).toEqual([])
  })

  test('never returns an incomplete source after cancellation or a failed later page', async () => {
    const controller = new AbortController()
    let calls = 0
    await expect(loadLorebookSearchEntries(async () => {
      calls++
      controller.abort()
      return { data: [1], total: 2 }
    }, controller.signal)).rejects.toThrow()
    expect(calls).toBe(1)
    calls = 0
    await expect(loadLorebookSearchEntries(async () => {
      if (calls++ === 0) return { data: [1], total: 2 }
      throw new Error('Later page failed')
    }, new AbortController().signal)).rejects.toThrow('Later page failed')
  })

  test('rejects missing rows rather than silently ranking a partial source', async () => {
    await expect(loadLorebookSearchEntries(async () => ({ data: [], total: 1 }), new AbortController().signal)).rejects.toThrow('Incomplete lorebook search source')
  })
})
