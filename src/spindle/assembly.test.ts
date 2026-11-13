import { describe, expect, test } from 'bun:test'
import { normalizeAssemblyGenerationType, validateAndNormalizeAssemblyBlocks } from './assembly'

describe('Spindle assembly input validation', () => {
  test('normalizes blocks and preserves native character tag triggers', () => {
    const [block] = validateAndNormalizeAssemblyBlocks([{
      id: 'block-1',
      name: 'Thread prompt',
      content: '{{description}}',
      role: 'system',
      enabled: true,
      position: 'pre_history',
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
      characterTagTrigger: ['hero'],
      group: null,
    }])
    expect(block.characterTagTrigger).toEqual(['hero'])
  })

  test('rejects invalid generation types and oversized graphs', () => {
    expect(() => normalizeAssemblyGenerationType('background')).toThrow('invalid')
    expect(() => validateAndNormalizeAssemblyBlocks(new Array(257).fill({}))).toThrow('maximum')
  })
})
