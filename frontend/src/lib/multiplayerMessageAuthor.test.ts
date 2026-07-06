import { describe, expect, test } from 'bun:test'
import { resolveMultiplayerMessageAuthor } from './multiplayerMessageAuthor'

describe('resolveMultiplayerMessageAuthor', () => {
  test('prefers the host-saved peer stamp over live participant churn', () => {
    const author = resolveMultiplayerMessageAuthor({
      roomId: 'room-1',
      fallbackDisplayName: 'User',
      participants: [
        {
          id: 'peer-1',
          role: 'peer',
          displayName: 'Live display',
          persona: { name: 'Live persona', avatarUrl: 'live-avatar' },
          status: 'active',
          isCurrentTurn: false,
        },
      ],
      message: {
        id: 'msg-1',
        chat_id: 'chat-1',
        index_in_chat: 0,
        is_user: true,
        name: 'Saved persona',
        content: 'hello',
        send_date: 1,
        swipe_id: 0,
        swipes: ['hello'],
        swipe_dates: [1],
        extra: {
          mp: {
            participantId: 'peer-1',
            displayName: 'Saved display',
            personaName: 'Saved persona',
            avatarUrl: 'saved-avatar',
          },
        },
        parent_message_id: null,
        branch_id: null,
        created_at: 1,
      },
    })

    expect(author).toEqual({
      displayName: 'Saved persona',
      avatarUrl: 'saved-avatar',
    })
  })

  test('does not backfill a stamped peer message from the live participant roster', () => {
    const author = resolveMultiplayerMessageAuthor({
      roomId: 'room-1',
      fallbackDisplayName: 'User',
      participants: [
        {
          id: 'peer-1',
          role: 'peer',
          displayName: 'Live display',
          persona: { name: 'Live persona', avatarUrl: 'live-avatar' },
          status: 'active',
          isCurrentTurn: false,
        },
      ],
      message: {
        id: 'msg-1',
        chat_id: 'chat-1',
        index_in_chat: 0,
        is_user: true,
        name: 'Saved display',
        content: 'hello',
        send_date: 1,
        swipe_id: 0,
        swipes: ['hello'],
        swipe_dates: [1],
        extra: {
          mp: {
            participantId: 'peer-1',
            displayName: 'Saved display',
          },
        },
        parent_message_id: null,
        branch_id: null,
        created_at: 1,
      },
    })

    expect(author).toEqual({
      displayName: 'Saved display',
      avatarUrl: null,
    })
  })

  test('falls back to the live roster for unstamped room-local messages', () => {
    const author = resolveMultiplayerMessageAuthor({
      roomId: 'room-1',
      fallbackDisplayName: 'User',
      participants: [
        {
          id: 'host-1',
          role: 'host',
          displayName: 'GM',
          persona: { name: 'GM Persona', avatarUrl: 'host-avatar' },
          status: 'active',
          isCurrentTurn: false,
        },
      ],
      message: {
        id: 'msg-1',
        chat_id: 'chat-1',
        index_in_chat: 0,
        is_user: true,
        name: 'GM Persona',
        content: 'hello',
        send_date: 1,
        swipe_id: 0,
        swipes: ['hello'],
        swipe_dates: [1],
        extra: {},
        parent_message_id: null,
        branch_id: null,
        created_at: 1,
      },
    })

    expect(author).toEqual({
      displayName: 'GM Persona',
      avatarUrl: 'host-avatar',
    })
  })
})
