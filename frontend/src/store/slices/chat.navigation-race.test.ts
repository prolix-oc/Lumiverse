/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import type { ChatSlice } from '@/types/store'

mock.module('@/api/settings', () => ({
  settingsApi: {
    put: async () => undefined,
  },
}))

let createChatSlice: typeof import('./chat').createChatSlice
const originalWindow = globalThis.window

beforeAll(async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: globalThis,
  })
  ;({ createChatSlice } = await import('./chat'))
})

afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: Window & typeof globalThis }).window
  } else {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    })
  }
})

function createStore(): ChatSlice {
  const state = {} as ChatSlice
  const set = (partial: Partial<ChatSlice> | ((current: ChatSlice) => Partial<ChatSlice>)) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  const get = () => state
  Object.assign(state, createChatSlice(set as never, get as never, {} as never))
  return state
}

describe('chat navigation during streaming', () => {
  test('hydrates a preloaded branch without exposing an empty message list', () => {
    const state = createStore()
    const branchMessage = {
      id: 'branch-message-1',
      chat_id: 'chat-2',
      index_in_chat: 0,
      is_user: true,
      name: 'User',
      content: 'branched',
      send_date: 1,
      swipe_id: 0,
      swipes: ['branched'],
      swipe_dates: [1],
      extra: {},
      parent_message_id: null,
      branch_id: 'branch-1',
      created_at: 1,
    }

    state.setActiveChat('chat-2', 'character-1', {
      messages: [branchMessage],
      total: 8,
      displayOwner: null,
      name: 'Branch',
      metadata: { wallpaper: { type: 'image', image_id: 'wallpaper-1' } },
      wallpaper: { type: 'image', image_id: 'wallpaper-1' },
    })

    expect(state.activeChatId).toBe('chat-2')
    expect(state.messages).toEqual([branchMessage])
    expect(state.totalChatLength).toBe(8)
    expect(state.activeChatName).toBe('Branch')
    expect(state.activeChatWallpaper?.image_id).toBe('wallpaper-1')
  })

  test('cancels a pending token flush when the active chat is cleared', () => {
    jest.useFakeTimers()
    const state = createStore()

    try {
      state.setActiveChat('chat-1')
      state.startStreaming('generation-1')
      state.appendStreamToken('late token')

      expect(state.getStreamBuffers().content).toBe('late token')

      state.setActiveChat(null)
      jest.runAllTimers()

      expect(state.activeChatId).toBeNull()
      expect(state.isStreaming).toBe(false)
      expect(state.streamingContent).toBe('')
      expect(state.getStreamBuffers()).toEqual({ content: '', reasoning: '' })
    } finally {
      jest.useRealTimers()
    }
  })

  test('freezes the latest stream frame while a chat navigation animates', () => {
    jest.useFakeTimers()
    const state = createStore()

    try {
      state.setActiveChat('chat-1')
      state.startStreaming('generation-1')
      state.appendStreamToken('latest frame')

      state.pauseStreamingForNavigation()
      expect(state.streamingNavigationPaused).toBe(true)
      expect(state.streamingContent).toBe('latest frame')
      expect(state.appendStreamToken(' ignored')).toBe('stale')

      jest.runAllTimers()
      expect(state.streamingContent).toBe('latest frame')
      expect(state.getStreamBuffers().content).toBe('latest frame')

      state.setActiveChat(null)
      expect(state.streamingNavigationPaused).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  test('clears reasoning timer state when switching chats', () => {
    const state = createStore()

    state.setActiveChat('chat-1')
    state.setStreamingReasoningStartedAt(1_000)
    state.streamingReasoningDuration = 5_000

    state.setActiveChat('chat-2')

    expect(state.streamingReasoningStartedAt).toBeNull()
    expect(state.streamingReasoningDuration).toBeNull()
  })

  test('starts each generation with a fresh render-facing reasoning clock', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-08-22T18:00:00.000Z'))
    const state = createStore()

    try {
      state.setActiveChat('chat-1')
      state.setStreamingReasoningStartedAt(1_000)
      state.streamingReasoningDuration = 5_000

      state.beginStreaming(null)

      expect(state.streamingReasoningStartedAt).toBeNull()
      expect(state.streamingReasoningDuration).toBeNull()

      state.appendStreamReasoning('first thought')

      expect(state.streamingReasoningStartedAt).toBe(Date.now())

      state.stopStreaming()
      state.setStreamingReasoningStartedAt(2_000)
      state.streamingReasoningDuration = 6_000

      state.startStreaming('generation-2')

      expect(state.streamingReasoningStartedAt).toBeNull()
      expect(state.streamingReasoningDuration).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  test('canonical FAILED replaces only the exact optimistic stopped request', () => {
    const state = createStore()
    state.beginGenerationRequest('chat-1', {
      generationType: 'normal',
      requestAuthorityId: 'authority-1',
    })
    expect(state.acceptGenerationRequest('chat-1', 'generation-1', 'authority-1', 'working')).toBe(true)
    state.stopGenerationRequest('chat-1')
    expect(state.generationRequests['chat-1']?.status).toBe('stopped')

    expect(state.settleGenerationRequest('chat-1', 'error', 'generation-1', 'authority-1')).toBe(true)
    expect(state.generationRequests['chat-1']?.status).toBe('error')
    expect(state.settleGenerationRequest('chat-1', 'stopped', 'generation-1', 'authority-1')).toBe(false)
    expect(state.generationRequests['chat-1']?.status).toBe('error')
    expect(state.settleGenerationRequest('chat-1', 'error', 'generation-other', 'authority-1')).toBe(false)
  })
})
