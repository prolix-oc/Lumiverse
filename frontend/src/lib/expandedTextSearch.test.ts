import { describe, expect, test } from 'bun:test'

import {
  findExpandedTextMatches,
  replaceAllExpandedTextMatches,
  replaceExpandedTextMatch,
} from './expandedTextSearch'

describe('expanded text search', () => {
  test('finds literal, case-insensitive, non-overlapping matches', () => {
    expect(findExpandedTextMatches('Alpha alpha ALPHA', 'alpha')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ])
    expect(findExpandedTextMatches('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
  })

  test('replaces only the selected match', () => {
    const matches = findExpandedTextMatches('one two one', 'one')
    expect(replaceExpandedTextMatch('one two one', matches[1], 'three')).toBe('one two three')
  })

  test('replaces all original matches without re-matching replacement text', () => {
    const value = 'a a a'
    expect(replaceAllExpandedTextMatches(value, findExpandedTextMatches(value, 'a'), 'aa')).toBe('aa aa aa')
  })
})
