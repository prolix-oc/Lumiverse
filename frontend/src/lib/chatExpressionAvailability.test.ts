import { describe, expect, test } from 'bun:test'
import type { ExpressionConfig } from '@/types/expressions'
import {
  chatHasDisplayableExpressions,
  getChatExpressionCharacterIds,
  hasDisplayableExpressions,
} from './chatExpressionAvailability'

function config(enabled: boolean, mappings: Record<string, string>): ExpressionConfig {
  return { enabled, defaultExpression: '', mappings }
}

describe('chat expression availability', () => {
  test('uses every group member instead of only the primary character', () => {
    expect(getChatExpressionCharacterIds('primary', true, ['primary', 'secondary'])).toEqual([
      'primary',
      'secondary',
    ])
    expect(getChatExpressionCharacterIds('primary', false, ['secondary'])).toEqual(['primary'])
  })

  test('deduplicates group members and ignores empty IDs', () => {
    expect(getChatExpressionCharacterIds('primary', true, ['secondary', '', 'secondary'])).toEqual([
      'secondary',
    ])
  })

  test('reports expressions when a non-primary member has an enabled mapping', async () => {
    const configs: Record<string, ExpressionConfig> = {
      primary: config(false, {}),
      secondary: config(true, { happy: 'happy-image' }),
    }

    await expect(chatHasDisplayableExpressions(
      ['primary', 'secondary'],
      async (id) => configs[id],
    )).resolves.toBe(true)
  })

  test('tolerates a failed member lookup and rejects disabled or empty configs', async () => {
    expect(hasDisplayableExpressions(config(false, { happy: 'happy-image' }))).toBe(false)
    expect(hasDisplayableExpressions(config(true, {}))).toBe(false)

    await expect(chatHasDisplayableExpressions(
      ['missing', 'empty'],
      async (id) => {
        if (id === 'missing') throw new Error('not found')
        return config(true, {})
      },
    )).resolves.toBe(false)
  })
})
