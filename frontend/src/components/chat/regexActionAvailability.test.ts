import { describe, expect, test } from 'bun:test'
import type { Message } from '@/types/api'
import { hasImmediateUserReply } from './regexActionAvailability'

function message(id: string, isUser: boolean, extra: Message['extra'] = {}): Message {
  return {
    id,
    chat_id: 'chat-1',
    index_in_chat: 0,
    is_user: isUser,
    name: isUser ? 'User' : 'Assistant',
    content: '',
    send_date: 0,
    swipe_id: 0,
    swipes: [''],
    swipe_dates: [0],
    extra,
    parent_message_id: null,
    branch_id: null,
    created_at: 0,
  }
}

describe('regex action reply availability', () => {
  test('disables actions when the immediately following visible message is from the user', () => {
    const messages = [message('assistant', false), message('user', true)]

    expect(hasImmediateUserReply(messages, 'assistant')).toBe(true)
  })

  test('keeps actions clickable when no message follows the assistant message', () => {
    const messages = [message('assistant', false)]

    expect(hasImmediateUserReply(messages, 'assistant')).toBe(false)
  })

  test('keeps actions clickable when the immediately following message is another assistant message', () => {
    const messages = [
      message('first-assistant', false),
      message('second-assistant', false),
      message('user', true),
    ]

    expect(hasImmediateUserReply(messages, 'first-assistant')).toBe(false)
    expect(hasImmediateUserReply(messages, 'second-assistant')).toBe(true)
  })

  test('ignores internal Loom injection rows when determining visible adjacency', () => {
    const messages = [
      message('assistant', false),
      message('injection', false, { _loom_inject: { source: 'test' } as any }),
      message('user', true),
    ]

    expect(hasImmediateUserReply(messages, 'assistant')).toBe(true)
  })
})
