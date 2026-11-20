import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { EditAndSendResult } from './chats'

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

function serverEditAndSend(partial: {
  branchChatId?: string
  editedMessageId?: string
  immediateAssistantId?: string | null
  generationId?: string
  mode?: EditAndSendResult['generationCursor']['mode']
} = {}): EditAndSendResult {
  const branchChatId = partial.branchChatId ?? 'chat-1'
  const editedMessageId = partial.editedMessageId ?? 'msg-1'
  return {
    branchChatId,
    editedMessageId,
    immediateAssistantId: partial.immediateAssistantId ?? null,
    generationCursor: {
      generationId: partial.generationId ?? 'gen-1',
      chatId: branchChatId,
      requestId: 'req-1',
      mode: partial.mode ?? 'normal',
    },
  }
}

describe('chatsApi.editAndSend', () => {
  beforeEach(() => {
    post.mockClear()
  })

  test('posts /chats/:chatId/edit-and-send with the contract body', async () => {
    const response = serverEditAndSend({ generationId: 'gen-1' })
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

  test('historical response reports the durable swipe target', async () => {
    const response = serverEditAndSend({
      branchChatId: 'chat-9',
      immediateAssistantId: 'asst-2',
      generationId: 'gen-swipe',
      mode: 'swipe',
    })
    post.mockResolvedValueOnce(response)

    await expect(chatsApi.editAndSend('chat-9', {
      messageId: 'msg-1',
      content: 'rewritten',
      expectedVersion: 7,
      requestId: 'req-hist',
    })).resolves.toEqual(response)
  })

  test('forwards in-place mode in the request body', async () => {
    const input = {
      messageId: 'msg-1',
      content: 'rewritten in place',
      expectedVersion: 7,
      requestId: 'req-in-place',
      branchChatOnEditAndSend: false,
    }
    post.mockResolvedValueOnce(serverEditAndSend({ branchChatId: 'chat-1' }))

    await expect(chatsApi.editAndSend('chat-1', input)).resolves.toMatchObject({ branchChatId: 'chat-1' })
    expect(post).toHaveBeenCalledWith('/chats/chat-1/edit-and-send', input, undefined)
  })

  test('forwards AbortSignal so the caller can cancel', async () => {
    const signal = new AbortController().signal
    post.mockResolvedValueOnce(serverEditAndSend())

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
