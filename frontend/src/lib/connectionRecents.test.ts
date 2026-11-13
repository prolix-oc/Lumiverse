import { expect, test } from 'bun:test'
import { recentConnectionIds, withRecentConnection } from './connectionRecents'

test('existing text picker history remains available until the first new selection', () => {
  expect(recentConnectionIds({}, 'llm', ['old', 'older'])).toEqual(['old', 'older'])
  expect(withRecentConnection({}, 'llm', 'new', ['old', 'older']).llm).toEqual(['new', 'old', 'older'])
  expect(recentConnectionIds({ llm: [] }, 'llm', ['old'])).toEqual([])
  expect(recentConnectionIds({}, 'embedding', ['old'])).toEqual([])
})

test('recent selections are unique, bounded, newest first and independent per connection type', () => {
  let recent = { imageGen: ['image'], llm: ['a'] }
  for (let i = 0; i < 12; i++) recent = withRecentConnection(recent, 'llm', `p${i}`) as typeof recent
  recent = withRecentConnection(recent, 'llm', 'p5') as typeof recent
  expect(recent.llm).toEqual(['p5', 'p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p4'])
  expect(recent.imageGen).toEqual(['image'])
  expect(withRecentConnection(recent, 'llm', '')).toBe(recent)
})
