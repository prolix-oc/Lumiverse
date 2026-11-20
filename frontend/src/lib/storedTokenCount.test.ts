import { describe, expect, test } from 'bun:test'

import { fnv1a32 } from './tokenCountCache'
import {
  TOKEN_COUNT_APPROXIMATE_EXTENSION,
  TOKEN_COUNT_HASH_EXTENSION,
  TOKEN_COUNT_LENGTH_EXTENSION,
  TOKEN_COUNT_MODEL_EXTENSION,
  TOKEN_COUNT_EXTENSION,
  readStoredTokenCount,
} from './storedTokenCount'

const MODEL = 'cl100k_base'
const CONTENT = 'same length'

function stored(content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [TOKEN_COUNT_EXTENSION]: 3,
    [TOKEN_COUNT_APPROXIMATE_EXTENSION]: false,
    [TOKEN_COUNT_MODEL_EXTENSION]: MODEL,
    [TOKEN_COUNT_LENGTH_EXTENSION]: content.length,
    [TOKEN_COUNT_HASH_EXTENSION]: fnv1a32(content),
    ...overrides,
  }
}

describe('readStoredTokenCount', () => {
  test('accepts a matching exact value', () => {
    expect(readStoredTokenCount(stored(CONTENT), MODEL, CONTENT)).toEqual({
      count: 3,
      exact: true,
      approximate: false,
      reason: 'exact',
    })
  })

  test('returns a valid approximate value without treating it as authoritative', () => {
    expect(readStoredTokenCount(stored(CONTENT, { [TOKEN_COUNT_APPROXIMATE_EXTENSION]: true }), MODEL, CONTENT)).toEqual({
      count: 3,
      exact: false,
      approximate: true,
      reason: 'approximate',
    })
  })

  test.each([
    ['missing model', { [TOKEN_COUNT_MODEL_EXTENSION]: undefined }, 'model-mismatch'],
    ['mismatched model', { [TOKEN_COUNT_MODEL_EXTENSION]: 'different-model' }, 'model-mismatch'],
    ['missing length', { [TOKEN_COUNT_LENGTH_EXTENSION]: undefined }, 'length-mismatch'],
    ['mismatched length', { [TOKEN_COUNT_LENGTH_EXTENSION]: CONTENT.length + 1 }, 'length-mismatch'],
    ['missing hash', { [TOKEN_COUNT_HASH_EXTENSION]: undefined }, 'hash-missing'],
    ['mismatched hash', { [TOKEN_COUNT_HASH_EXTENSION]: fnv1a32('different!') }, 'hash-mismatch'],
  ] as const)('%s is displayable but never authoritative', (_label, overrides, reason) => {
    const result = readStoredTokenCount(stored(CONTENT, overrides), MODEL, CONTENT)

    expect(result.count).toBe(3)
    expect(result.exact).toBe(false)
    expect(result.approximate).toBe(true)
    expect(result.reason).toBe(reason)
  })

  test('rejects a same-length content edit via the content hash', () => {
    const edited = 'new content'
    expect(edited.length).toBe(CONTENT.length)
    expect(readStoredTokenCount(stored(CONTENT), MODEL, edited)).toEqual({
      count: 3,
      exact: false,
      approximate: true,
      reason: 'hash-mismatch',
    })
  })

  test.each([
    ['missing extensions', undefined],
    ['null extensions', null],
    ['non-object extensions', 'malformed'],
  ])('handles %s as missing stored data', (_label, extensions) => {
    expect(readStoredTokenCount(extensions, MODEL, CONTENT)).toEqual({
      count: null,
      exact: false,
      approximate: false,
      reason: 'missing',
    })
  })

  test('rejects malformed and non-finite counts', () => {
    for (const count of ['3', 3.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readStoredTokenCount(stored(CONTENT, { [TOKEN_COUNT_EXTENSION]: count }), MODEL, CONTENT)).toEqual({
        count: null,
        exact: false,
        approximate: false,
        reason: 'invalid-count',
      })
    }
  })

  test('treats a null stored count as missing', () => {
    expect(readStoredTokenCount(stored(CONTENT, { [TOKEN_COUNT_EXTENSION]: null }), MODEL, CONTENT)).toEqual({
      count: null,
      exact: false,
      approximate: false,
      reason: 'missing',
    })
  })

  test('accepts null content as the empty-content identity', () => {
    expect(readStoredTokenCount(stored('', { [TOKEN_COUNT_EXTENSION]: 0 }), MODEL, null)).toEqual({
      count: 0,
      exact: true,
      approximate: false,
      reason: 'exact',
    })
  })

  test('keeps hashless legacy values approximate', () => {
    expect(readStoredTokenCount({
      [TOKEN_COUNT_EXTENSION]: 3,
      [TOKEN_COUNT_MODEL_EXTENSION]: MODEL,
      [TOKEN_COUNT_LENGTH_EXTENSION]: CONTENT.length,
    }, MODEL, CONTENT)).toEqual({
      count: 3,
      exact: false,
      approximate: true,
      reason: 'hash-missing',
    })
  })
})
