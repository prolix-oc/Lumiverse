import { describe, expect, test } from 'bun:test'
import type { GuidedGeneration } from '@/types/store'
import { isGuideActive, isGuideAutoEnabled } from './guided-generations'

const guide: GuidedGeneration = {
  id: 'guide-1',
  name: 'Guide',
  content: 'Content',
  position: 'system',
  mode: 'persistent',
  enabled: false,
  autoEnable: { scope: 'character', id: 'character-1' },
}

describe('guided generation context state', () => {
  test('reports matching automatic activation', () => {
    const context = { characterId: 'character-1' }
    expect(isGuideAutoEnabled(guide, context)).toBe(true)
    expect(isGuideActive(guide, context)).toBe(true)
  })

  test('keeps unmatched guides inactive', () => {
    expect(isGuideActive(guide, { characterId: 'character-2' })).toBe(false)
  })

  test('manual activation takes precedence over an unmatched rule', () => {
    expect(isGuideActive({ ...guide, enabled: true }, { characterId: 'character-2' })).toBe(true)
  })
})
