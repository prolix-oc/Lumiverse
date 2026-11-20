import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Character } from '@/types/api'

const applyAppearance = mock(() => Promise.resolve({ chat: { metadata: {} } }))
const setActiveChatMetadata = mock(() => undefined)
const updateMessage = mock(() => undefined)
const storeState = {
  activeChatId: 'chat1',
  activeChatMetadata: {} as Record<string, unknown>,
  setActiveChatMetadata,
  updateMessage,
}

mock.module('@/api/chats', () => ({
  chatsApi: { applyAppearance },
}))
mock.module('@/store', () => ({
  useStore: { getState: () => storeState },
}))

const { applyChatAppearance } = await import('./chatAppearance')

function makeCharacter(id: string): Character {
  return { id, name: id } as Character
}

describe('applyChatAppearance character targeting', () => {
  beforeEach(() => {
    applyAppearance.mockClear()
    setActiveChatMetadata.mockClear()
    updateMessage.mockClear()
  })

  test('defaults character_id to the passed character so group members are addressed', async () => {
    await applyChatAppearance('chat1', makeCharacter('char2'), {
      type: 'avatar',
      avatar_entry_id: 'winter-avatar',
    })

    expect(applyAppearance).toHaveBeenCalledWith('chat1', {
      type: 'avatar',
      avatar_entry_id: 'winter-avatar',
      character_id: 'char2',
    })
  })

  test('keeps an explicitly provided character_id', async () => {
    await applyChatAppearance('chat1', makeCharacter('char1'), {
      type: 'greeting',
      greeting_index: 1,
      character_id: 'char3',
    })

    expect(applyAppearance).toHaveBeenCalledWith('chat1', {
      type: 'greeting',
      greeting_index: 1,
      character_id: 'char3',
    })
  })

  test('defaults character_id on field actions too', async () => {
    await applyChatAppearance('chat1', makeCharacter('char2'), {
      type: 'field',
      field: 'description',
      variant_id: 'winter-desc',
    })

    expect(applyAppearance).toHaveBeenCalledWith('chat1', {
      type: 'field',
      field: 'description',
      variant_id: 'winter-desc',
      character_id: 'char2',
    })
  })
})
