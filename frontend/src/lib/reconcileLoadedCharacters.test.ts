/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import type { Character } from '@/types/api'
import { reconcileLoadedCharacters } from './reconcileLoadedCharacters'

const character = (id: string) => ({ id, name: id }) as Character

describe('reconcileLoadedCharacters', () => {
  test('keeps an imported character when a stale background load finishes after it', () => {
    const before = [character('existing')]
    const imported = character('imported')

    expect(reconcileLoadedCharacters(
      new Set(before.map((item) => item.id)),
      before,
      [imported, ...before],
    )).toEqual([imported, ...before])
  })

  test('does not duplicate characters already returned by the server', () => {
    const imported = character('imported')
    const loaded = [character('existing'), imported]

    expect(reconcileLoadedCharacters(new Set(['existing']), loaded, [imported])).toEqual(loaded)
  })

  test('does not retain a pre-existing character missing from the server response', () => {
    const oldCharacter = character('old')
    expect(reconcileLoadedCharacters(new Set([oldCharacter.id]), [], [oldCharacter])).toEqual([])
  })
})
