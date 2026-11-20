import { afterEach, describe, expect, mock, test } from 'bun:test'
mock.module('@/store', () => ({ useStore: () => null }))
const { planTokenCountSweep } = await import('./useTokenCounts')
import {
  clearTokenCountCache,
  fnv1a32,
  makeTokenCountCacheKey,
  setTokenCount,
} from '@/lib/tokenCountCache'
import {
  TOKEN_COUNT_EXTENSION,
  TOKEN_COUNT_HASH_EXTENSION,
  TOKEN_COUNT_LENGTH_EXTENSION,
  TOKEN_COUNT_MODEL_EXTENSION,
} from '@/lib/storedTokenCount'

const MODEL = 'test/model'

afterEach(() => clearTokenCountCache())

describe('planTokenCountSweep', () => {
  test('plans a large book once while skipping authoritative stored and cached counts', () => {
    const entries = Array.from({ length: 5_000 }, (_, index) => ({
      id: `entry-${index}`,
      content: `content-${index}`,
      extensions: index === 0
        ? {
            [TOKEN_COUNT_EXTENSION]: 2,
            [TOKEN_COUNT_MODEL_EXTENSION]: MODEL,
            [TOKEN_COUNT_LENGTH_EXTENSION]: 'content-0'.length,
            [TOKEN_COUNT_HASH_EXTENSION]: fnv1a32('content-0'),
          }
        : undefined,
    }))
    const cachedContent = entries[1]!.content
    setTokenCount(makeTokenCountCacheKey(MODEL, cachedContent), {
      count: 2,
      approximate: false,
      model: MODEL,
      contentLength: cachedContent.length,
    })

    const plan = planTokenCountSweep(entries, MODEL)

    expect(plan).toHaveLength(4_998)
    expect(plan.some((request) => request.entryId === 'entry-0')).toBe(false)
    expect(plan.some((request) => request.entryId === 'entry-1')).toBe(false)
    expect(plan[0]?.entryId).toBe('entry-2')
    expect(new Set(plan.map((request) => request.entryId)).size).toBe(plan.length)
  })
})
