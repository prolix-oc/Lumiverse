import { describe, expect, test } from 'bun:test'
import { shouldPermanentlyQuarantineRegex } from './quarantine-policy'

describe('shouldPermanentlyQuarantineRegex', () => {
  test('rejects durable timing evidence when the scheduler is congested', () => {
    expect(shouldPermanentlyQuarantineRegex('(a+)+$', true)).toBe(false)
  })

  test('does not quarantine literals or ordinary linear patterns', () => {
    for (const pattern of ['literal', '^ok$', 'a+', '(ab)+', '[^,]*']) {
      expect(shouldPermanentlyQuarantineRegex(pattern, false)).toBe(false)
    }
  })

  test('recognises nested unbounded quantifiers', () => {
    for (const pattern of ['(a+)+$', '(x*)*', '((a)*)*$', '(a{2,})+']) {
      expect(shouldPermanentlyQuarantineRegex(pattern, false)).toBe(true)
    }
  })

  test('ignores escaped operators and operators inside character classes', () => {
    expect(shouldPermanentlyQuarantineRegex('\\(a\\+\\)\\+', false)).toBe(false)
    expect(shouldPermanentlyQuarantineRegex('[()+*]+', false)).toBe(false)
  })
})
