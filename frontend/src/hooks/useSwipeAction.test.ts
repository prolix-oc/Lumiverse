import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ChatSlice } from '@/types/store'
import type { Message } from '@/types/api'

let store: StoreApi<ChatSlice>
let request: Record<string, unknown> | undefined
let finish: (value: { generationId: string }) => void
let feedback: { onSkip(): Promise<void> } | undefined
const options = { activeProfileId: 'profile', activePersonaId: null, regenFeedback: { enabled: false },
  getActivePresetForGeneration: () => null, openModal: (_id: string, value: typeof feedback) => { feedback = value } }
mock.module('@/api/settings', () => ({ settingsApi: { put: async () => undefined } }))
mock.module('@/store', () => ({ useStore: { getState: () => ({ ...store.getState(), ...options }) } }))
mock.module('@/api/chats', () => ({ messagesApi: { swipe: async () => undefined } }))
mock.module('@/api/generate', () => ({ generateApi: { start: (input: Record<string, unknown>) => {
  request = input
  return new Promise<{ generationId: string }>(resolve => { finish = resolve })
} } }))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))
const { createChatSlice } = await import('@/store/slices/chat')
const { executeSwipe } = await import('./useSwipeAction')
const message = (): Message => ({ id: 'reply', chat_id: 'chat', index_in_chat: 0, is_user: false,
  name: 'Assistant', content: 'reading', swipes: ['reading', 'another'], swipe_id: 0, swipe_dates: [1, 2],
  send_date: 1, created_at: 1, extra: {}, parent_message_id: null, branch_id: null })

beforeEach(() => {
  store = createStore<ChatSlice>()(createChatSlice)
  store.getState().setActiveChat('chat')
  store.getState().setMessages([message()])
  request = undefined; feedback = undefined; options.regenFeedback.enabled = false
})

describe('native background swipe action', () => {
  test('starts from an older swipe with the target anchored before the HTTP response', async () => {
    const action = executeSwipe(message(), 'chat', 'right', { background: true })
    expect(request).toMatchObject({ background_swipe: true, generation_type: 'swipe', message_id: 'reply' })
    expect(store.getState()).toMatchObject({ streamingSwipeId: 2, streamingPreserveSwipe: true })
    expect(store.getState().messages[0]).toMatchObject({ swipe_id: 0, content: 'reading' })
    await executeSwipe(message(), 'chat', 'right', { background: true })
    finish({ generationId: 'generation' }); await action
    expect(store.getState().activeGenerationId).toBe('generation')
    store.getState().stopStreaming()
  })

  test('a late response cannot start a stream in a different chat', async () => {
    const action = executeSwipe(message(), 'chat', 'right', { background: true })
    store.getState().setActiveChat('other')
    finish({ generationId: 'generation' }); await action
    expect(store.getState().isStreaming).toBe(false)
    expect(store.getState().activeGenerationId).toBeNull()
  })

  test('rechecks the target after the feedback dialog', async () => {
    options.regenFeedback.enabled = true
    await executeSwipe(message(), 'chat', 'right', { background: true })
    store.getState().setActiveChat('other')
    await feedback!.onSkip()
    expect(request).toBeUndefined()
  })
})
