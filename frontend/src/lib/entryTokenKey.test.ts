import { describe, expect, test } from 'bun:test'

import { createEntryTokenKeyMemo, type TokenKeyEntry } from './entryTokenKey'
import { fnv1a32 } from './tokenCountCache'

describe('entry token key memo', () => {
  test('reuses a key for the same immutable entry object and model', () => {
    const hashed: string[] = []
    const memo = createEntryTokenKeyMemo((content) => {
      hashed.push(content)
      return fnv1a32(content)
    })
    const entry: TokenKeyEntry = { id: 'entry-a', content: 'same content' }

    const first = memo.keyFor(entry, 'model-a')
    const second = memo.keyFor(entry, 'model-a')

    expect(second).toBe(first)
    expect(hashed).toEqual(['same content'])
    expect(memo.hashCount()).toBe(1)
  })

  test('rehashes a replacement object even when content length is unchanged', () => {
    const hashed: string[] = []
    const memo = createEntryTokenKeyMemo((content) => {
      hashed.push(content)
      return fnv1a32(content)
    })
    const original: TokenKeyEntry = { id: 'entry-a', content: 'aaaa' }
    const replacement: TokenKeyEntry = { id: 'entry-a', content: 'bbbb' }

    const originalKey = memo.keyFor(original, 'model-a')
    const replacementKey = memo.keyFor(replacement, 'model-a')
    const repeatedReplacementKey = memo.keyFor(replacement, 'model-a')

    expect(replacementKey).not.toBe(originalKey)
    expect(repeatedReplacementKey).toBe(replacementKey)
    expect(hashed).toEqual(['aaaa', 'bbbb'])
    expect(memo.hashCount()).toBe(2)
  })

  test('rehashes once for a model change and reuses the new model key', () => {
    const hashed: string[] = []
    const memo = createEntryTokenKeyMemo((content) => {
      hashed.push(content)
      return fnv1a32(content)
    })
    const entry: TokenKeyEntry = { id: 'entry-a', content: 'content' }

    const first = memo.keyFor(entry, 'model-a')
    const second = memo.keyFor(entry, 'model-b')
    const repeated = memo.keyFor(entry, 'model-b')

    expect(second).not.toBe(first)
    expect(second.startsWith('model-b:')).toBe(true)
    expect(repeated).toBe(second)
    expect(hashed).toEqual(['content', 'content'])
    expect(memo.hashCount()).toBe(2)
  })

  test('rehashes once for a replacement length change and reuses the new key', () => {
    const hashed: string[] = []
    const memo = createEntryTokenKeyMemo((content) => {
      hashed.push(content)
      return fnv1a32(content)
    })
    const original: TokenKeyEntry = { id: 'entry-a', content: 'short' }
    const replacement: TokenKeyEntry = { id: 'entry-a', content: 'longer content' }

    const originalKey = memo.keyFor(original, 'model-a')
    const replacementKey = memo.keyFor(replacement, 'model-a')
    const repeatedReplacementKey = memo.keyFor(replacement, 'model-a')

    expect(replacementKey).not.toBe(originalKey)
    expect(replacementKey.startsWith('model-a:14:')).toBe(true)
    expect(repeatedReplacementKey).toBe(replacementKey)
    expect(hashed).toEqual(['short', 'longer content'])
    expect(memo.hashCount()).toBe(2)
  })

  test('forget removes only the entry object record', () => {
    const memo = createEntryTokenKeyMemo(fnv1a32)
    const entry: TokenKeyEntry = { id: 'entry-a', content: 'content' }
    const otherEntry: TokenKeyEntry = { id: 'entry-b', content: 'other' }

    const first = memo.keyFor(entry, 'model-a')
    const otherKey = memo.keyFor(otherEntry, 'model-a')
    memo.forget(entry)
    const second = memo.keyFor(entry, 'model-a')
    const repeatedOtherKey = memo.keyFor(otherEntry, 'model-a')

    expect(second).toBe(first)
    expect(repeatedOtherKey).toBe(otherKey)
    expect(memo.hashCount()).toBe(3)
  })

  // Entry snapshots must be replaced, not mutated in place; identity-based memoization cannot observe same-length mutations.
  test('requires immutable entry snapshots for reliable memoization', () => {
    const memo = createEntryTokenKeyMemo(fnv1a32)
    const entry: TokenKeyEntry = { id: 'entry-a', content: 'aaaa' }

    const first = memo.keyFor(entry, 'model-a')
    entry.content = 'bbbb'
    const second = memo.keyFor(entry, 'model-a')

    expect(second).toBe(first)
    expect(memo.hashCount()).toBe(1)
  })
})
