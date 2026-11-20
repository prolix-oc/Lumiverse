import { describe, expect, test } from 'bun:test'

import { ESTIMATE_CHARS_PER_TOKEN, estimateTokens } from './tokenEstimate'

describe('estimateTokens', () => {
  test('uses UTF-16 string length with monotonic ceiling rounding', () => {
    expect(ESTIMATE_CHARS_PER_TOKEN).toBe(4)
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('a'.repeat(8))).toBe(2)
    expect(estimateTokens('a'.repeat(9))).toBe(3)
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })

  test('counts Unicode by UTF-16 code units', () => {
    expect('🙂'.length).toBe(2)
    expect(estimateTokens('🙂')).toBe(1)
    expect(estimateTokens('🙂🙂')).toBe(1)
    expect(estimateTokens('🙂🙂🙂')).toBe(2)
    expect(estimateTokens('a🙂b')).toBe(1)
    expect(estimateTokens('a🙂bc')).toBe(2)
  })

  test('returns zero for nullish and empty content', () => {
    expect(estimateTokens(null)).toBe(0)
    expect(estimateTokens(undefined)).toBe(0)
    expect(estimateTokens('')).toBe(0)
  })

  test('rejects unsupported runtime values instead of coercing them', () => {
    expect(() => estimateTokens(0 as never)).toThrow(TypeError)
    expect(() => estimateTokens(false as never)).toThrow(TypeError)
    expect(() => estimateTokens({ length: 4 } as never)).toThrow(TypeError)
    expect(() => estimateTokens(['text'] as never)).toThrow(TypeError)
  })

  test('always returns a finite non-negative integer approximation', () => {
    const fixtures = [null, undefined, '', 'x', 'four', 'five!', '🙂', 'x'.repeat(401)]

    for (const content of fixtures) {
      const result = estimateTokens(content)
      expect(Number.isFinite(result)).toBe(true)
      expect(Number.isInteger(result)).toBe(true)
      expect(result >= 0).toBe(true)
      expect(result).toBe(content == null ? 0 : Math.ceil(content.length / 4))
    }
  })
})
