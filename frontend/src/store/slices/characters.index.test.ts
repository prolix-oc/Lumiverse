import { expect, test } from 'bun:test'
import { createCharactersSlice } from './characters'
import type { Character, CharacterIndexItem } from '@/types/api'
import type { CharactersSlice } from '@/types/store'

function store() {
  const state = {} as CharactersSlice
  const set = (update: any) => Object.assign(state, typeof update === 'function' ? update(state) : update)
  Object.assign(state, createCharactersSlice(set as any, () => state, {} as any))
  return state
}
const index = (id: string, name = id) => ({ id, name, tags: [], folder: '', library_scope: 'mine' }) as CharacterIndexItem
const character = (id: string, name = id) => ({ ...index(id, name), description: 'Large prompt', extensions: { private: 'large', avatar_crop_image_id: 'crop' } }) as unknown as Character

test('a late index read preserves intervening edits, additions and deletions', () => {
  const state = store()
  state.setCharacterIndex([index('edit'), index('delete')], 0)
  const started = state.characterIndexRevision
  state.updateCharacter('edit', character('edit', 'New name'))
  state.addCharacter(character('add'))
  state.removeCharacter('delete')
  state.setCharacterIndex([index('edit', 'Old name'), index('delete'), index('unchanged')], started)
  expect(state.characterIndex.map(item => item.id).sort()).toEqual(['add', 'edit', 'unchanged'])
  expect(state.characterIndex.find(item => item.id === 'edit')?.name).toBe('New name')
  expect(state.characterIndex.find(item => item.id === 'edit')?.avatar_crop_image_id).toBe('crop')
  expect(state.characterIndex[0]).not.toHaveProperty('description')
  expect(state.characterIndex[0]).not.toHaveProperty('extensions')
  expect(state.charactersLoaded).toBe(false)
})

test('empty indexes are loaded, while bulk invalidation changes the request generation', () => {
  const state = store()
  state.setCharacterIndex([], 0)
  expect(state.characterIndexLoaded).toBe(true)
  state.invalidateCharacterIndex()
  expect(state.characterIndexLoaded).toBe(false)
  expect(state.characterIndexGeneration).toBe(1)
})
