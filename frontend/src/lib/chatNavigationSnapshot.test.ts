import { afterEach, describe, expect, test } from 'bun:test'
import type { Chat, Message } from '@/types/api'
import {
  clearChatNavigationSnapshots,
  stageChatNavigationSnapshot,
  takeChatNavigationSnapshot,
} from './chatNavigationSnapshot'

const chat: Chat = {
  id: 'branch-1',
  character_id: 'character-1',
  name: 'Branch',
  metadata: {},
  created_at: 1,
  updated_at: 1,
}

const message = {
  id: 'message-1',
  chat_id: chat.id,
} as Message

afterEach(() => clearChatNavigationSnapshots())

describe('chat navigation snapshots', () => {
  test('hands a preloaded branch to ChatView exactly once', () => {
    const snapshot = {
      chat,
      messagePage: { data: [message], total: 12 },
    }

    stageChatNavigationSnapshot(snapshot)

    expect(takeChatNavigationSnapshot(chat.id)).toBe(snapshot)
    expect(takeChatNavigationSnapshot(chat.id)).toBeNull()
  })

  test('keeps snapshots isolated by target chat', () => {
    stageChatNavigationSnapshot({ chat, messagePage: { data: [message], total: 1 } })

    expect(takeChatNavigationSnapshot('another-chat')).toBeNull()
    expect(takeChatNavigationSnapshot(chat.id)?.messagePage.data).toEqual([message])
  })
})
