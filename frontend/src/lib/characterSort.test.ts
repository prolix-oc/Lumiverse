import { describe, expect, test } from 'bun:test'
import type { CharacterSortField } from '@/types/store'

import {
  isGroupCharacterSortField,
  resolveGroupCharacterSort,
  resolveGroupCharacterSortDirection,
} from './characterSort'

describe('group character sort compatibility', () => {
  test('allows only Recent, Name, and Created in Group Chats', () => {
    const supported: CharacterSortField[] = ['name', 'recent', 'created']
    const unsupported: CharacterSortField[] = ['author', 'tokens', 'shuffle']

    expect(supported.map(isGroupCharacterSortField)).toEqual([
      true,
      true,
      true,
    ])
    expect(unsupported.map(isGroupCharacterSortField)).toEqual([
      false,
      false,
      false,
    ])
  })

  test('coerces character-only sorts to newest groups first', () => {
    expect(resolveGroupCharacterSort('author')).toBe('recent')
    expect(resolveGroupCharacterSort('tokens')).toBe('recent')
    expect(resolveGroupCharacterSortDirection('tokens', 'asc')).toBe('desc')
    expect(resolveGroupCharacterSortDirection('created', 'asc')).toBe('asc')
  })
})
