import { beforeEach, describe, expect, test } from 'bun:test'

import {
  TOKEN_CACHE_MAX_ENTRIES,
  clearTokenCountCache,
  deleteTokenCount,
  fnv1a32,
  getTokenCount,
  getTokenCountCacheVersion,
  makeTokenCountCacheKey,
  peekTokenCountByKey,
  setTokenCount,
  subscribeTokenCountCache,
  touchTokenCount,
} from './tokenCountCache'

const valueFor = (index: number) => ({
  count: index,
  approximate: false,
  model: 'tokenizer-main',
  contentLength: index,
})

const fillCache = () => {
  for (let index = 0; index < TOKEN_CACHE_MAX_ENTRIES; index += 1) {
    setTokenCount(`entry:${index}`, valueFor(index))
  }
}

describe('token count cache', () => {
  beforeEach(() => {
    clearTokenCountCache()
  })

  test('keeps at most 2000 records and evicts the exact least-recently-read record', () => {
    fillCache()

    expect(getTokenCount('entry:0')).toEqual(valueFor(0))
    setTokenCount('entry:next', valueFor(TOKEN_CACHE_MAX_ENTRIES))

    expect(peekTokenCountByKey('entry:0')).toEqual(valueFor(0))
    expect(peekTokenCountByKey('entry:1')).toBeUndefined()
    expect(peekTokenCountByKey('entry:next')).toEqual(valueFor(TOKEN_CACHE_MAX_ENTRIES))
  })

  test('does not promote on peek, but promotes on touch', () => {
    fillCache()

    expect(peekTokenCountByKey('entry:0')).toEqual(valueFor(0))
    setTokenCount('entry:peek-next', valueFor(TOKEN_CACHE_MAX_ENTRIES))

    expect(peekTokenCountByKey('entry:0')).toBeUndefined()

    clearTokenCountCache()
    fillCache()
    touchTokenCount('entry:0')
    setTokenCount('entry:touch-next', valueFor(TOKEN_CACHE_MAX_ENTRIES))

    expect(peekTokenCountByKey('entry:0')).toEqual(valueFor(0))
    expect(peekTokenCountByKey('entry:1')).toBeUndefined()
  })

  test('overwrites, deletes, and clears cached records', () => {
    setTokenCount('entry:a', valueFor(1))
    setTokenCount('entry:a', { ...valueFor(2), approximate: true })

    expect(getTokenCount('entry:a')).toEqual({ ...valueFor(2), approximate: true })

    deleteTokenCount('entry:a')
    expect(peekTokenCountByKey('entry:a')).toBeUndefined()

    setTokenCount('entry:b', valueFor(3))
    setTokenCount('entry:c', valueFor(4))
    clearTokenCountCache()

    expect(peekTokenCountByKey('entry:b')).toBeUndefined()
    expect(peekTokenCountByKey('entry:c')).toBeUndefined()
  })

  test('increments versions and notifies active subscribers once per visible mutation', () => {
    const notifiedVersions: number[] = []
    const unsubscribe = subscribeTokenCountCache(() => {
      notifiedVersions.push(getTokenCountCacheVersion())
    })
    const initialVersion = getTokenCountCacheVersion()

    setTokenCount('entry:a', valueFor(1))
    const afterInsert = getTokenCountCacheVersion()
    expect(afterInsert).toBeGreaterThan(initialVersion)
    expect(notifiedVersions).toEqual([afterInsert])

    getTokenCount('entry:a')
    touchTokenCount('entry:a')
    expect(getTokenCountCacheVersion()).toBe(afterInsert)
    expect(notifiedVersions).toEqual([afterInsert])

    setTokenCount('entry:a', valueFor(2))
    const afterOverwrite = getTokenCountCacheVersion()
    expect(afterOverwrite).toBeGreaterThan(afterInsert)
    expect(notifiedVersions).toEqual([afterInsert, afterOverwrite])

    deleteTokenCount('entry:a')
    const afterDelete = getTokenCountCacheVersion()
    expect(afterDelete).toBeGreaterThan(afterOverwrite)
    expect(notifiedVersions).toEqual([afterInsert, afterOverwrite, afterDelete])

    setTokenCount('entry:b', valueFor(3))
    const afterSecondInsert = getTokenCountCacheVersion()
    clearTokenCountCache()
    const afterClear = getTokenCountCacheVersion()
    expect(afterClear).toBeGreaterThan(afterSecondInsert)

    unsubscribe()
    unsubscribe()
    setTokenCount('entry:c', valueFor(4))
    const afterDetachedInsert = getTokenCountCacheVersion()
    deleteTokenCount('entry:missing')
    expect(getTokenCountCacheVersion()).toBe(afterDetachedInsert)
    clearTokenCountCache()
    const afterFirstClear = getTokenCountCacheVersion()
    clearTokenCountCache()
    expect(getTokenCountCacheVersion()).toBe(afterFirstClear)
    expect(notifiedVersions).toEqual([afterInsert, afterOverwrite, afterDelete, afterSecondInsert, afterClear])
  })

  test('notifies a snapshot of subscribers', () => {
    const notifications: string[] = []
    let unsubscribeSecond = () => {}
    const unsubscribeFirst = subscribeTokenCountCache(() => {
      notifications.push('first')
      unsubscribeSecond()
    })
    unsubscribeSecond = subscribeTokenCountCache(() => {
      notifications.push('second')
    })

    setTokenCount('entry:a', valueFor(1))
    expect(notifications).toEqual(['first', 'second'])

    setTokenCount('entry:b', valueFor(2))
    expect(notifications).toEqual(['first', 'second', 'first'])
    unsubscribeFirst()
  })

  test('uses fixed-width hashes and never retains representative raw content in keys or records', () => {
    const rawContent = 'private world-book text: 7f6d89b8-8d75-4c31-b0e4-32fcb4e381a3'
    const model = 'tokenizer-main'
    const key = makeTokenCountCacheKey(model, rawContent)

    expect(fnv1a32(rawContent)).toMatch(/^[0-9a-f]{8}$/)
    expect(key).toBe(`${model}:${rawContent.length}:${fnv1a32(rawContent)}`)
    expect(key).not.toContain(rawContent)

    setTokenCount(key, {
      count: 17,
      approximate: false,
      model,
      contentLength: rawContent.length,
    })

    const record = peekTokenCountByKey(key)
    expect(record).toEqual({
      count: 17,
      approximate: false,
      model,
      contentLength: rawContent.length,
    })
    expect(JSON.stringify(record)).not.toContain(rawContent)
    expect(Object.values(record ?? {})).not.toContain(rawContent)
  })
})
