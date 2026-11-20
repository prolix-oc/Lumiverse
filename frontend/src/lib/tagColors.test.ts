import { describe, expect, test } from 'bun:test'
import { getTagColorVar } from './tagColors'

describe('tag color variables', () => {
  test('returns a paintable RGB triple without relying on undefined theme variables', () => {
    const color = getTagColorVar('example')

    expect(color).toMatch(/^\d{1,3}, \d{1,3}, \d{1,3}$/)
    expect(color).not.toContain('var(')
  })
})
