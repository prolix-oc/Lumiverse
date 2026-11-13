import { describe, expect, test } from 'bun:test'

import { createStore } from 'zustand/vanilla'
import { createPersonasSlice, updateRecentPersonaIds } from './personas'
import type { PersonasSlice } from '@/types/store'

test('distinguishes an unloaded persona list from a loaded empty account', () => {
  const store = createStore<PersonasSlice>(createPersonasSlice)
  expect(store.getState().personasLoaded).toBe(false)
  store.getState().setPersonas([])
  expect(store.getState().personasLoaded).toBe(true)
})

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
