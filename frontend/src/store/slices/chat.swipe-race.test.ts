/// <reference types="bun-types" />

import { describe, expect, mock, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'
import type { ChatSlice } from '@/types/store'
import type { Message } from '@/types/api'

mock.module('@/api/settings', () => ({ settingsApi: { put: async () => undefined } }))
const { createChatSlice } = await import('./chat')

function message(id = 'assistant'): Message {
  return {
    id, chat_id: 'chat', index_in_chat: 0, is_user: false, name: 'Assistant',
    content: 'original', send_date: 1, swipe_id: 0, swipes: ['original'],
    swipe_dates: [1], extra: {}, parent_message_id: null, branch_id: null, created_at: 1,
  }
}

function setup() {
  const store = createStore<ChatSlice>()(createChatSlice)
  store.getState().setActiveChat('chat')
  store.getState().setMessages([message()])
  return store
}

describe('streaming swipe reconciliation', () => {
  test('background optimism, missed staging and stale refresh never select the generated swipe', () => {
    const store = setup()
    store.getState().beginStreaming('assistant', 'swipe', 1)
    expect(store.getState().streamingSwipeId).toBe(1)
    expect(store.getState().messages[0]).toMatchObject({ swipe_id: 0, content: 'original' })
    store.getState().startStreaming('background', 'assistant', 'swipe')
    store.getState().setStreamingSwipeId(1, true)
    expect(store.getState().messages[0]).toMatchObject({ swipe_id: 0, content: 'original', swipes: ['original', ''] })
    store.getState().setMessages([message()])
    expect(store.getState().messages[0]).toMatchObject({ swipe_id: 0, content: 'original', swipes: ['original', ''] })
    store.getState().endStreaming()
    expect(store.getState().messages[0].swipe_id).toBe(0)
  })
  for (const type of ['swipe', 'regenerate']) {
    test(`${type} recovery stages a missing swipe atomically with its stream anchor`, () => {
      const store = setup()
      store.getState().startStreaming('generation', 'assistant', type)
      const invalidFrames: ChatSlice[] = []
      const unsubscribe = store.subscribe((state) => {
        if (state.streamingSwipeId != null && state.messages[0].swipes.length <= state.streamingSwipeId) {
          invalidFrames.push(state)
        }
      })

      store.getState().setStreamingSwipeId(1)
      unsubscribe()

      expect(invalidFrames).toEqual([])
      expect(store.getState().messages[0]).toMatchObject({ swipe_id: 1, swipes: ['original', ''], content: '' })
      store.getState().stopStreaming()
    })
  }

  for (const method of ['setMessages', 'reconcileMessagesTail'] as const) {
    test(`${method} cannot erase a swipe staged after the request began`, () => {
      const store = setup()
      const stale = store.getState().messages[0]
      const staged = { ...stale, swipe_id: 1, swipes: ['original', ''], swipe_dates: [1, 2], content: '' }
      store.getState().beginStreaming('assistant', 'swipe')
      store.getState().updateMessage('assistant', staged)
      store.getState().startStreaming('generation', 'assistant', 'swipe')
      store.getState().setStreamingSwipeId(1)

      if (method === 'setMessages') store.getState().setMessages([stale], 1)
      else store.getState().reconcileMessagesTail({ data: [stale], total: 1, offset: 0 })

      expect(store.getState().messages[0]).toEqual(staged)
      expect(store.getState().activeGenerationId).toBe('generation')
      store.getState().stopStreaming()
    })
  }

  test('repairs messages loaded after the stream anchor arrives', () => {
    const store = setup()
    store.getState().setMessages([])
    store.getState().startStreaming('generation', 'assistant', 'swipe')
    store.getState().setStreamingSwipeId(1)
    store.getState().setMessages([message()])

    expect(store.getState().messages[0]).toMatchObject({ swipe_id: 1, swipes: ['original', ''], content: '' })
    store.getState().stopStreaming()
  })

  test('preserves intentional navigation to older swipes through recovery and refresh', () => {
    const store = setup()
    const navigated = { ...message(), swipes: ['original', ''], swipe_dates: [1, 2] }
    store.getState().setMessages([navigated])
    store.getState().startStreaming('generation', 'assistant', 'swipe')
    store.getState().setStreamingSwipeId(1)
    store.getState().reconcileMessagesTail({ data: [message()], total: 1, offset: 0 })
    store.getState().setStreamingSwipeId(1)

    expect(store.getState().messages[0]).toEqual(navigated)
    const completed = { ...navigated, swipes: ['original', 'finished'] }
    store.getState().reconcileMessagesTail({ data: [completed], total: 1, offset: 0 })
    store.getState().endStreaming()
    expect(store.getState().messages[0]).toEqual(completed)
  })

  test('allows authoritative swipe cleanup after streaming stops', () => {
    const store = setup()
    store.getState().startStreaming('generation', 'assistant', 'swipe')
    store.getState().setStreamingSwipeId(1)
    store.getState().stopStreaming()
    store.getState().reconcileMessagesTail({ data: [message()], total: 1, offset: 0 })

    expect(store.getState().messages).toEqual([message()])
  })
})
