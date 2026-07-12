import { describe, expect, test } from 'bun:test'
import { createSettingsLoadGenerationGuard } from './settings-load-generation'

// The settings slice depends on the full store and browser APIs, so the token
// seam is tested directly instead of mocking the entire slice.
describe('settings load generation guard', () => {
  test('keeps an older response stale after a newer load starts', () => {
    const guard = createSettingsLoadGenerationGuard()
    const firstGeneration = guard.begin()

    expect(guard.isCurrent(firstGeneration)).toBe(true)

    const secondGeneration = guard.begin()

    expect(guard.isCurrent(firstGeneration)).toBe(false)
    expect(guard.isCurrent(secondGeneration)).toBe(true)
  })
})
