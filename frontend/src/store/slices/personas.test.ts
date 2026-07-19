import { describe, expect, test } from 'bun:test'

import { updateRecentPersonaIds } from './personas'

describe('updateRecentPersonaIds', () => {
  test('moves an activated persona to the front without duplicates', () => {
    expect(updateRecentPersonaIds(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
  })

  test('keeps only the five most recently activated personas', () => {
    expect(updateRecentPersonaIds(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['f', 'a', 'b', 'c', 'd'])
  })

  test('does not use edit timestamps or other persona data', () => {
    expect(updateRecentPersonaIds(['older-edit', 'newer-edit'], 'older-edit')).toEqual([
      'older-edit',
      'newer-edit',
    ])
  })
})
