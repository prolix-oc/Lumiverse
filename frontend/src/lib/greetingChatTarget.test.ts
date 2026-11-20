import { describe, expect, test } from 'bun:test'
import { buildGreetingChatTarget, shouldStartNewChatForGreeting } from './greetingChatTarget'

describe('greeting chat target', () => {
  test('only starts a new chat after the conversation has progressed', () => {
    expect(shouldStartNewChatForGreeting(0)).toBe(false)
    expect(shouldStartNewChatForGreeting(1)).toBe(false)
    expect(shouldStartNewChatForGreeting(2)).toBe(true)
  })

  test('targets the selected greeting in a new solo chat', () => {
    expect(buildGreetingChatTarget({
      characterId: 'character-1',
      greetingIndex: 2,
      isGroupChat: false,
      groupCharacterIds: [],
    })).toEqual({
      kind: 'solo',
      input: {
        character_id: 'character-1',
        greeting_index: 2,
      },
    })
  })

  test('preserves group members and targets the greeting character', () => {
    expect(buildGreetingChatTarget({
      characterId: 'character-2',
      greetingIndex: 1,
      isGroupChat: true,
      groupCharacterIds: ['character-1', 'character-2'],
      greetingCharacterId: 'character-2',
    })).toEqual({
      kind: 'group',
      input: {
        character_ids: ['character-1', 'character-2'],
        greeting_character_id: 'character-2',
        greeting_index: 1,
      },
    })
  })
})
