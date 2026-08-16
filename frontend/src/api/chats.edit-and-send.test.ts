import { beforeEach, describe, expect, mock, test } from 'bun:test'

const post = mock((..._args: unknown[]) => Promise.resolve(undefined))

mock.module('./client', () => ({
  del: mock(),
  get: mock(),
  post,
  put: mock(),
  patch: mock(),
  upload: mock(),
}))

const { chatsApi } = await import('./chats')

const edited = {
  id: 'msg-1',
  chat_id: 'chat-1',
  index_in_chat: 0,
  is_user: true,
  name: 'User',
  content: 'rewritten',
  send_date: 1,
  swipe_id: 0,
  swipes: ['rewritten'],
  swipe_dates: [1],
  extra: {},
  parent_message_id: null,
  branch_id: null,
  created_at: 42,
}

describe('chatsApi.editAndSend', () => {
  beforeEach(() => {
    post.mockClear()
  })

  test('posts /chats/:chatId/edit-and-send with the contract body', async () => {
    const response = { message: edited, immediateAssistantId: null, generationId: 'gen-1' }
    post.mockResolvedValueOnce(response)

    const input = {
      messageId: 'msg-1',
      content: 'rewritten',
      expectedVersion: 42,
      requestId: 'req-1',
    }
    await expect(chatsApi.editAndSend('chat-1', input)).resolves.toEqual(response)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/chats/chat-1/edit-and-send', input, undefined)
  })

  test('historical response preserves immediateAssistantId for the swipe path', async () => {
    const response = { message: edited, immediateAssistantId: 'asst-2', generationId: null }
    post.mockResolvedValueOnce(response)

    await expect(chatsApi.editAndSend('chat-9', {
      messageId: 'msg-1',
      content: 'rewritten',
      expectedVersion: 7,
      requestId: 'req-hist',
    })).resolves.toEqual(response)
  })

  test('forwards AbortSignal so the caller can cancel', async () => {
    const signal = new AbortController().signal
    post.mockResolvedValueOnce({ message: edited })

    await chatsApi.editAndSend('chat-1', {
      messageId: 'msg-1',
      content: 'rewritten',
      expectedVersion: 42,
      requestId: 'req-cancel',
    }, { signal })

    expect(post).toHaveBeenCalledWith(
      '/chats/chat-1/edit-and-send',
      expect.objectContaining({ requestId: 'req-cancel' }),
      { signal },
    )
  })

  test('propagates API failure', async () => {
    post.mockRejectedValueOnce(new Error('conflict'))
    await expect(chatsApi.editAndSend('chat-1', {
      messageId: 'msg-1',
      content: 'rewritten',
      expectedVersion: 42,
      requestId: 'req-fail',
    })).rejects.toThrow('conflict')
  })
})
