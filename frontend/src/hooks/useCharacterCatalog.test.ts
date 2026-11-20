import { beforeEach, expect, mock, test } from 'bun:test'
import { resetAccountReads } from '@/lib/shared-read'
import { createCharactersSlice } from '@/store/slices/characters'
import type { Character, CharacterIndexItem } from '@/types/api'

let state: any
const requests: Array<(items: CharacterIndexItem[]) => void> = []
const batchRequests: Array<(items: Character[]) => void> = []
mock.module('@/store', () => ({ useStore: { getState: () => state } }))
mock.module('@/api/characters', () => ({ charactersApi: {
  listIndex: () => new Promise<CharacterIndexItem[]>(resolve => requests.push(resolve)),
  getBatch: () => new Promise<Character[]>(resolve => batchRequests.push(resolve)),
} }))
const { loadCharacterIndex, refreshCachedCharacters } = await import('./useCharacterCatalog')
const item = (name: string) => ({ id: name, name, tags: [] }) as CharacterIndexItem
beforeEach(() => {
  resetAccountReads(); requests.length = 0; batchRequests.length = 0
  state = { user: { id: 'u1' }, isAuthenticated: true }
  const set = (update: any) => Object.assign(state, typeof update === 'function' ? update(state) : update)
  Object.assign(state, createCharactersSlice(set as any, () => state, {} as any))
})

test('many catalog consumers share loading and an empty result is complete', async () => {
  const a = loadCharacterIndex(); const b = loadCharacterIndex()
  expect(requests).toHaveLength(1)
  requests[0]([]); await Promise.all([a, b])
  await loadCharacterIndex()
  expect(requests).toHaveLength(1)
  expect(state.characterIndexLoaded).toBe(true)
})
test('bulk invalidation prevents an older response from replacing a newer index', async () => {
  const old = loadCharacterIndex()
  state.invalidateCharacterIndex()
  const fresh = loadCharacterIndex()
  requests[1]([item('fresh')]); await fresh
  requests[0]([item('old')]); await old
  expect(state.characterIndex.map((entry: CharacterIndexItem) => entry.id)).toEqual(['fresh'])
})
test('logout and login to the same account fence responses from the previous session', async () => {
  const old = loadCharacterIndex()
  resetAccountReads()
  const fresh = loadCharacterIndex()
  requests[0]([item('old session')]); await old
  expect(state.characterIndexLoaded).toBe(false)
  requests[1]([item('current session')]); await fresh
  expect(state.characterIndex[0].id).toBe('current session')
})

test('bulk detail refresh cannot overwrite a newer edit or resurrect a deleted character', async () => {
  const a = { ...item('a'), updated_at: 0 } as Character
  const b = { ...item('b'), updated_at: 0 } as Character
  state.addCharacters([a, b])
  const refresh = refreshCachedCharacters()
  state.updateCharacter('a', { ...a, name: 'Newer edit', updated_at: 1 })
  state.removeCharacter('b')
  batchRequests[0]([{ ...a, name: 'Old snapshot' }, b])
  await refresh
  expect(state.characters.map((entry: Character) => entry.name)).toEqual(['Newer edit'])
  expect(state.characterIndex.map((entry: CharacterIndexItem) => entry.id)).toEqual(['a'])
})
