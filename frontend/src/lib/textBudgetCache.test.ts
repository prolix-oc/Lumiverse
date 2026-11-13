import { expect, test } from 'bun:test'
import { TextBudgetCache } from './textBudgetCache'

test('bounds large text histories even when the entry count is small', () => {
  const cache = new TextBudgetCache<string>(300, 2 * 1024 * 1024, value => value.length)
  for (let frame = 0; frame < 300; frame++) {
    cache.set(`frame-${frame}`, 'x'.repeat(100_000 + frame * 100))
  }
  expect(cache.size).toBeLessThan(20)
  expect(cache.retainedCharacters).toBeLessThanOrEqual(2 * 1024 * 1024)
  expect(cache.has('frame-299')).toBe(true)
  expect(cache.has('frame-0')).toBe(false)
})

test('reaccounts resolved promises, replacement, deletion, and clearing', () => {
  const cache = new TextBudgetCache<{ text?: string; pending?: number }>(3, 20,
    value => value.text?.length ?? value.pending ?? 0)
  cache.set('a', { pending: 10 })
  cache.set('b', { text: 'bbb' })
  expect(cache.retainedCharacters).toBe(15)
  cache.set('a', { text: 'a' })
  expect(cache.retainedCharacters).toBe(6)
  cache.delete('b')
  cache.delete('b')
  expect(cache.retainedCharacters).toBe(2)
  cache.clear()
  expect(cache.retainedCharacters).toBe(0)
  expect(cache.size).toBe(0)
})

test('rejects a single oversized entry without evicting useful small results', () => {
  const cache = new TextBudgetCache<string>(2, 10, value => value.length)
  cache.set('a', 'small')
  cache.set('huge', 'x'.repeat(20))
  expect([...cache.keys()]).toEqual(['a'])
  cache.set('b', '')
  cache.set('c', '')
  expect([...cache.keys()]).toEqual(['b', 'c'])
  cache.set('b', 'too large to reuse')
  expect(cache.has('b')).toBe(false)
  expect(cache.retainedCharacters).toBe(1)
})
