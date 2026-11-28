import { describe, expect, test } from 'bun:test'
import { isCharacterContentSearchValid } from './characterSearch'

describe('content search input', () => {
  test('accepts Unicode trigrams and rejects short words anywhere in a query', () => {
    for (const query of ['', '   ', 'friend', 'magic school', '魔法図書館', '😀😃😄', '  friend\nmagic  ']) {
      expect(isCharacterContentSearchValid(query)).toBe(true)
    }
    for (const query of ['hi', 'a friend', 'hello to', '魔法', '😀😃']) {
      expect(isCharacterContentSearchValid(query)).toBe(false)
    }
  })
})
