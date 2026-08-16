import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Message } from '@/types/api'

const generateStart = mock(() => Promise.resolve({ generationId: 'gen-swipe' }))
const beginStreaming = mock(() => {})
const startStreaming = mock(() => {})
const setStreamingError = mock(() => {})

const storeState = {
  messages: [] as Message[],
  isStreaming: false,
  regeneratingMessageId: null as string | null,
  streamingSwipeId: null as number | null,
  streamingGenerationType: null as string | null,
  beginStreaming,
  startStreaming,
  setStreamingError,
  activeProfileId: 'profile-1',
  activePersonaId: 'persona-1',
  activeCharacterId: 'char-1',
  getActivePresetForGeneration: () => 'preset-1',
  regenFeedback: { enabled: false, position: 'system' as const },
  openModal: mock(() => {}),
}

const useStoreMock = Object.assign(
  <T,>(selector: (state: typeof storeState) => T): T => selector(storeState),
  { getState: () => storeState },
)

mock.module('@/store', () => ({ useStore: useStoreMock }))
mock.module('@/api/chats', () => ({
  messagesApi: { swipe: mock(() => Promise.resolve({})) },
}))
mock.module('@/api/generate', () => ({
  generateApi: { start: generateStart },
}))
mock.module('@/lib/loom/runtimeProfile', () => ({
  shouldForceLoomRuntimePreset: () => false,
}))
mock.module('@/i18n', () => ({
  default: { t: (key: string) => key },
}))
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const {
  applyEditAndSendResult,
  editAndSendUsesSwipePath,
  findSubsequentAssistant,
  startSwipeGeneration,
} = await import('./useSwipeAction')

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'is_user'>): Message {
  return {
    chat_id: 'chat-1',
    index_in_chat: 0,
    name: partial.is_user ? 'User' : 'Assistant',
    content: partial.content ?? '',
    send_date: 1,
    swipe_id: 0,
    swipes: [partial.content ?? ''],
    swipe_dates: [1],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: 1,
    ...partial,
  }
}

const user = msg({ id: 'user-1', is_user: true, content: 'hello', index_in_chat: 0 })
const assistant = msg({ id: 'asst-1', is_user: false, content: 'hi', index_in_chat: 1, swipe_id: 0, swipes: ['hi'] })

describe('useSwipeAction edit-and-send', () => {
  beforeEach(() => {
    generateStart.mockClear()
    generateStart.mockResolvedValue({ generationId: 'gen-swipe' })
    beginStreaming.mockClear()
    startStreaming.mockClear()
    setStreamingError.mockClear()
    storeState.isStreaming = false
    storeState.messages = [user, assistant]
  })

  test('historical: subsequent assistant uses the swipe generate path', async () => {
    const path = await applyEditAndSendResult('chat-1', 'user-1', { immediateAssistantId: 'asst-1' })
    expect(path).toBe('swipe')
    expect(editAndSendUsesSwipePath({ immediateAssistantId: 'asst-1' })).toBe(true)
    expect(generateStart).toHaveBeenCalledTimes(1)
    expect(generateStart).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 'chat-1',
      message_id: 'asst-1',
      generation_type: 'swipe',
    }))
    expect(beginStreaming).toHaveBeenCalledWith('asst-1', 'swipe')
    expect(startStreaming).toHaveBeenCalledWith('gen-swipe', 'asst-1', 'swipe')
  })

  test('tail: no subsequent assistant starts new generation without generateApi.start', async () => {
    storeState.messages = [user]
    const path = await applyEditAndSendResult('chat-1', 'user-1', { immediateAssistantId: null })
    expect(path).toBe('new_generation')
    expect(editAndSendUsesSwipePath({ immediateAssistantId: null })).toBe(false)
    expect(generateStart).not.toHaveBeenCalled()
    expect(beginStreaming).toHaveBeenCalledWith(undefined, 'continue')
  })

  test('empty: user messages do not start a swipe generation', async () => {
    await startSwipeGeneration(user, 'chat-1')
    expect(generateStart).not.toHaveBeenCalled()
    expect(beginStreaming).not.toHaveBeenCalled()
  })

  test('cancellation: a newer swipe start drops the stale generate response', async () => {
    let resolveFirst: (value: { generationId: string }) => void = () => {}
    const first = new Promise<{ generationId: string }>((resolve) => { resolveFirst = resolve })
    generateStart.mockReturnValueOnce(first)
    generateStart.mockResolvedValueOnce({ generationId: 'gen-second' })

    const firstRun = startSwipeGeneration(assistant, 'chat-1')
    await startSwipeGeneration(assistant, 'chat-1')
    resolveFirst({ generationId: 'gen-stale' })
    await firstRun

    expect(startStreaming).toHaveBeenCalledTimes(1)
    expect(startStreaming).toHaveBeenCalledWith('gen-second', 'asst-1', 'swipe')
  })

  test('failure: swipe generate errors surface through setStreamingError', async () => {
    generateStart.mockRejectedValueOnce(Object.assign(new Error('down'), { body: { error: 'down' } }))
    await expect(startSwipeGeneration(assistant, 'chat-1')).rejects.toThrow('down')
    expect(setStreamingError).toHaveBeenCalledWith('down')
    expect(startStreaming).not.toHaveBeenCalled()
  })

  test('findSubsequentAssistant returns the next assistant after a user turn', () => {
    const later = msg({ id: 'asst-2', is_user: false, content: 'later', index_in_chat: 3 })
    const extraUser = msg({ id: 'user-2', is_user: true, content: 'again', index_in_chat: 2 })
    expect(findSubsequentAssistant([user, assistant, extraUser, later], 'user-1')?.id).toBe('asst-1')
    expect(findSubsequentAssistant([user, assistant, extraUser, later], 'user-2')?.id).toBe('asst-2')
    expect(findSubsequentAssistant([user], 'user-1')).toBeUndefined()
  })
})
