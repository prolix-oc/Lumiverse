import { describe, expect, test } from 'bun:test'
import type { Character } from '@/types/api'
import { previewAppearanceMetadata, setAlternateFieldVariants } from './avatarBindings'

function character(): Character {
  return {
    id: 'char-1',
    name: 'Character',
    avatar_path: null,
    image_id: 'primary-image',
    description: '',
    personality: '',
    scenario: '',
    first_mes: 'Hello',
    mes_example: '',
    creator: '',
    creator_notes: '',
    library_scope: 'mine',
    system_prompt: '',
    post_history_instructions: '',
    folder: '',
    tags: [],
    alternate_greetings: ['Winter hello'],
    talkativeness: 0.5,
    extensions: {
      alternate_fields: {
        description: [{ id: 'winter-desc', label: 'Winter', content: 'Winter coat' }],
      },
      alternate_avatars: [{ id: 'winter-avatar', image_id: 'winter-image', label: 'Winter' }],
      avatar_bindings: {
        'winter-avatar': { description: 'winter-desc', personality: null, greeting_index: 1 },
      },
    },
    created_at: 0,
    updated_at: 0,
  }
}

describe('alternate field bindings', () => {
  test('unlinks deleted variants from all avatars without losing other bindings', () => {
    const kept = { id: 'kept', label: 'Kept', content: 'Still here' }
    const extensions = {
      alternate_fields: { description: [{ id: 'removed', label: 'Removed', content: 'Gone' }, kept] },
      avatar_bindings: {
        primary: { description: 'removed', personality: 'personality-1', greeting_index: 1 },
        second: { description: 'removed' },
        third: { description: 'kept', scenario: null },
      },
    }

    const updated = setAlternateFieldVariants(extensions, 'description', [kept])

    expect(updated.avatar_bindings).toEqual({
      primary: { personality: 'personality-1', greeting_index: 1 },
      third: { description: 'kept', scenario: null },
    })
    expect(updated.alternate_fields.description).toEqual([kept])
    expect(extensions.avatar_bindings.primary.description).toBe('removed')
    expect(extensions.avatar_bindings.second.description).toBe('removed')
  })

  test('removes empty field and avatar binding containers after deleting the last variant', () => {
    const updated = setAlternateFieldVariants({
      alternate_fields: { description: [{ id: 'removed', label: 'Removed', content: '' }] },
      avatar_bindings: { primary: { description: 'removed' } },
    }, 'description', [])

    expect(updated).toEqual({})
  })

  test('preserves bindings when editing an existing variant', () => {
    const updated = setAlternateFieldVariants({
      alternate_fields: { description: [{ id: 'kept', label: 'Before', content: '' }] },
      avatar_bindings: { primary: { description: 'kept' }, second: { description: null } },
    }, 'description', [{ id: 'kept', label: 'After', content: 'Changed' }])

    expect(updated.avatar_bindings).toEqual({ primary: { description: 'kept' }, second: { description: null } })
  })
})

describe('avatar appearance previews', () => {
  test('applies the complete binding before the request resolves', () => {
    const metadata = previewAppearanceMetadata(character(), {
      alternate_field_selections: { personality: 'old-personality' },
    }, { type: 'avatar', avatar_entry_id: 'winter-avatar' })

    expect(metadata.active_avatar_id).toBe('winter-image')
    expect(metadata.active_avatar_entry_id).toBe('winter-avatar')
    expect(metadata.alternate_field_selections).toEqual({ description: 'winter-desc' })
    expect(metadata.activeGreetingIndex).toBe(1)
  })

  test('keeps group member appearance isolated', () => {
    const metadata = previewAppearanceMetadata(character(), {
      group: true,
      character_ids: ['char-1', 'char-2'],
      group_active_avatar_ids: { 'char-2': 'other-image' },
    }, { type: 'field', field: 'description', variant_id: 'winter-desc', character_id: 'char-1' })

    expect(metadata.group_active_avatar_ids).toEqual({
      'char-1': 'winter-image',
      'char-2': 'other-image',
    })
    expect(metadata.group_alternate_field_selections['char-1']).toEqual({ description: 'winter-desc' })
  })

  test('does not optimistically select a deleted variant from an old avatar binding', () => {
    const staleCharacter = character()
    staleCharacter.extensions!.alternate_fields = {}

    const metadata = previewAppearanceMetadata(staleCharacter, {}, {
      type: 'avatar', avatar_entry_id: 'winter-avatar',
    })

    expect(metadata.active_avatar_id).toBe('winter-image')
    expect(metadata.alternate_field_selections).toBeUndefined()
  })
})
