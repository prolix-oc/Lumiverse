/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ChatSlice } from '@/types/store'
import type { GenerationStatusResponse } from '@/api/generate'
import type { Message, PaginatedResult } from '@/types/api'

let store: StoreApi<ChatSlice>
let getStatus: ReturnType<typeof mock>
let list: ReturnType<typeof mock>
let getMessage: ReturnType<typeof mock>
mock.module('@/store', () => ({ useStore: {
  getState: () => store.getState(),
  setState: (...args: Parameters<typeof store.setState>) => store.setState(...args),
} }))
mock.module('@/api/settings', () => ({ settingsApi: { put: async () => undefined } }))
mock.module('@/api/generate', () => ({ generateApi: { getStatus: (...args: unknown[]) => getStatus(...args) } }))
mock.module('@/api/chats', () => ({ messagesApi: { list: (...args: unknown[]) => list(...args), get: (...args: unknown[]) => getMessage(...args) } }))
const { createChatSlice } = await import('@/store/slices/chat')
const { recoverPooledGeneration } = await import('./generation-recovery')

const original: Message = {
  id: 'assistant', chat_id: 'chat', index_in_chat: 0, is_user: false, name: 'Assistant',
  content: 'original', send_date: 1, swipe_id: 0, swipes: ['original'],
  swipe_dates: [1], extra: {}, parent_message_id: null, branch_id: null, created_at: 1,
}
const active: GenerationStatusResponse = {
  active: true, generationId: 'generation', generationType: 'swipe',
  status: 'streaming', targetMessageId: 'assistant', targetSwipeId: 1, content: 'live',
}
const completed: GenerationStatusResponse = {
  active: false, generationId: 'previous', status: 'completed', completedMessageId: 'assistant',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  store = createStore<ChatSlice>()(createChatSlice)
  store.getState().setActiveChat('chat')
  store.getState().setMessages([original])
  getStatus = mock(async () => completed)
  list = mock(async () => ({ data: [original], total: 1, offset: 0, limit: 50 }))
  getMessage = mock(async () => original)
})

describe('generation recovery races', () => {
  test('equivalent concurrent recovery shares status and terminal message refresh', async () => {
    const response = deferred<GenerationStatusResponse>()
    getStatus = mock(() => response.promise)
    const first = recoverPooledGeneration('chat')
    const second = recoverPooledGeneration('chat')
    expect(first).toBe(second)
    expect(getStatus).toHaveBeenCalledTimes(1)
    response.resolve(completed)
    await Promise.all([first, second])
    expect(list).toHaveBeenCalledTimes(1)
    await recoverPooledGeneration('chat')
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  test('returning to the same chat uses a new recovery and rejects the old snapshot', async () => {
    const old = deferred<GenerationStatusResponse>()
    getStatus = mock(() => old.promise)
    const first = recoverPooledGeneration('chat')
    store.getState().setActiveChat('other')
    store.getState().setActiveChat('chat')
    getStatus = mock(async () => ({ active: false }))
    await recoverPooledGeneration('chat')
    expect(getStatus).toHaveBeenCalledTimes(1)
    old.resolve(active)
    await first
    expect(store.getState().isStreaming).toBe(false)
  })

  test('reconnecting after a persisted generation stops restores its saved partial reply', async () => {
    store.getState().startStreaming('generation', 'assistant', 'normal', 'persisted-message')
    getStatus = mock(async () => ({ active: false, generationId: 'generation', status: 'stopped', renderMode: 'persisted-message', targetMessageId: 'assistant' }))
    const saved = { ...original, content: 'saved partial', swipes: ['saved partial'], extra: { reasoning: 'saved thought' } }
    getMessage = mock(async () => saved)
    await recoverPooledGeneration('chat')
    expect(store.getState().isStreaming).toBe(false)
    expect(store.getState().messages).toEqual([saved])
    expect(getMessage).toHaveBeenCalledTimes(1)
  })

  test('terminal persisted recovery cannot overwrite a newer generation', async () => {
    getStatus = mock(async () => ({ active: false, generationId: 'generation', status: 'stopped', renderMode: 'persisted-message', targetMessageId: 'assistant' }))
    const response = deferred<Message>(), requested = deferred<void>()
    getMessage = mock(() => { requested.resolve(); return response.promise })
    const recovery = recoverPooledGeneration('chat')
    await requested.promise
    store.getState().startStreaming('next', 'assistant', 'normal')
    response.resolve({ ...original, content: 'old partial' })
    await recovery
    expect(store.getState().messages).toEqual([original])
    expect(store.getState().activeGenerationId).toBe('next')
  })

  test('persisted-message recovery refreshes the selected text and reasoning without a stream buffer', async () => {
    getStatus = mock(async () => ({ ...active, renderMode: 'persisted-message', targetSwipeId: undefined, content: '' }))
    const saved = { ...original, content: 'second', swipes: ['first', 'second'], swipe_dates: [1, 1], swipe_id: 1, extra: { reasoning: 'second thoughts' } }
    getMessage = mock(async () => saved)
    await recoverPooledGeneration('chat')
    expect(store.getState().streamingRenderMode).toBe('persisted-message')
    expect(store.getState().messages).toEqual([saved])
    expect(store.getState().streamingContent).toBe('')
    expect(store.getState().streamingSwipeId).toBeNull()
    store.getState().endStreaming()
    expect(store.getState().streamingRenderMode).toBeNull()
  })

  test('a delayed persisted-message refresh cannot replace a newer edit event', async () => {
    getStatus = mock(async () => ({ ...active, renderMode: 'persisted-message', targetSwipeId: undefined, content: '' }))
    const response = deferred<Message>()
    getMessage = mock(() => response.promise)
    const work = recoverPooledGeneration('chat')
    await Promise.resolve(); await Promise.resolve()
    store.getState().updateMessage(original.id, { content: 'newer text', extra: { reasoning: 'newer reasoning' } })
    response.resolve({ ...original, content: 'older text' })
    await work
    expect(store.getState().messages[0]!.content).toBe('newer text')
  })
  test('reconciles a matching completed generation normally', async () => {
    store.getState().startStreaming('previous', 'assistant', 'swipe')
    await recoverPooledGeneration('chat')

    expect(store.getState().isStreaming).toBe(false)
    expect(store.getState().activeGenerationId).toBeNull()
    expect(list).toHaveBeenCalledTimes(1)
    expect(store.getState().messages).toEqual([original])
  })

  test('background recovery stages a missing target without changing the selected reply', async () => {
    getStatus = mock(async () => ({ ...active, backgroundSwipe: true }))
    await recoverPooledGeneration('chat')
    expect(store.getState().messages[0]).toMatchObject({ swipe_id: 0, content: 'original', swipes: ['original', ''] })
    expect(store.getState().streamingSwipeId).toBe(1)
    expect(store.getState().streamingContent).toBe('live')
  })

  test('recovers a missed start while the new swipe is still assembling', async () => {
    getStatus = mock(async () => ({ ...active, status: 'assembling', content: '' }))
    await recoverPooledGeneration('chat')

    expect(store.getState().isStreaming).toBe(true)
    expect(store.getState().messages[0]).toMatchObject({ swipe_id: 1, swipes: ['original', ''] })
  })

  test('merges a matching delta without losing tokens received during the poll', async () => {
    store.getState().startStreaming('generation', 'assistant', 'swipe')
    store.getState().reconcileStreamContent('live', 0)
    const status = deferred<GenerationStatusResponse>()
    getStatus = mock(() => status.promise)
    const recovery = recoverPooledGeneration('chat')
    store.getState().reconcileStreamContent('live response', 0)
    status.resolve({ ...active, content: ' response', contentOffset: 4 })
    await recovery

    expect(getStatus).toHaveBeenCalledWith('chat', { generationId: 'generation', contentLen: 4, reasoningLen: 0 })
    expect(store.getState().streamingContent).toBe('live response')
  })

  test('recovers a continue on its existing swipe without switching the visible swipe', async () => {
    const message = { ...original, swipes: ['original', 'other'], swipe_dates: [1, 2] }
    store.getState().setMessages([message])
    getStatus = mock(async () => ({ ...active, generationType: 'continue' }))
    await recoverPooledGeneration('chat')

    expect(store.getState().messages[0]).toEqual(message)
    expect(store.getState().streamingSwipeId).toBe(1)
    expect(store.getState().streamingContent).toBe('live')
  })

  test('restores the swipe as well as its tokens when staging events were missed', async () => {
    getStatus = mock(async () => active)
    await recoverPooledGeneration('chat')

    expect(store.getState().messages[0]).toMatchObject({ swipe_id: 1, swipes: ['original', ''], content: '' })
    expect(store.getState().streamingContent).toBe('live')
    expect(store.getState().streamingSwipeId).toBe(1)
  })

  test('does not apply a previous completion while a new request is awaiting its generation ID', async () => {
    store.getState().beginStreaming('assistant', 'swipe')
    await recoverPooledGeneration('chat')

    expect(store.getState().isStreaming).toBe(true)
    expect(store.getState().streamingGenerationType).toBe('swipe')
    expect(list).not.toHaveBeenCalled()
  })

  for (const response of [active, completed]) {
    test(`ignores an old ${response.status} poll that resolves after a new swipe starts`, async () => {
      const status = deferred<GenerationStatusResponse>()
      getStatus = mock(() => status.promise)
      const recovery = recoverPooledGeneration('chat')
      store.getState().beginStreaming('assistant', 'swipe')
      store.getState().startStreaming('new-generation', 'assistant', 'swipe')
      status.resolve(response)
      await recovery

      expect(store.getState().activeGenerationId).toBe('new-generation')
      expect(store.getState().isStreaming).toBe(true)
      expect(store.getState().streamingContent).toBe('')
      expect(list).not.toHaveBeenCalled()
    })
  }

  test('ignores completion for a different generation already streaming when the poll starts', async () => {
    store.getState().startStreaming('new-generation', 'assistant', 'swipe')
    await recoverPooledGeneration('chat')

    expect(store.getState().activeGenerationId).toBe('new-generation')
    expect(list).not.toHaveBeenCalled()
  })

  test('does not reattach a swipe anchor when the store rejects an ended generation', async () => {
    store.getState().markGenerationEnded('generation')
    getStatus = mock(async () => active)
    await recoverPooledGeneration('chat')

    expect(store.getState().isStreaming).toBe(false)
    expect(store.getState().streamingSwipeId).toBeNull()
    expect(store.getState().streamingContent).toBe('')
  })

  test('ignores a completion refresh that resolves after the next generation begins', async () => {
    const fresh = deferred<PaginatedResult<Message>>()
    const requested = deferred<void>()
    list = mock(() => { requested.resolve(); return fresh.promise })
    const recovery = recoverPooledGeneration('chat')
    await requested.promise
    store.getState().beginStreaming('assistant', 'swipe')
    store.getState().startStreaming('new-generation', 'assistant', 'swipe')
    const staged = { ...original, swipe_id: 1, swipes: ['original', ''], swipe_dates: [1, 2], content: '' }
    store.getState().updateMessage('assistant', staged)
    fresh.resolve({ data: [original], total: 1, offset: 0, limit: 50 })
    await recovery

    expect(store.getState().messages[0]).toEqual(staged)
    expect(store.getState().activeGenerationId).toBe('new-generation')
  })

  test('does not resume a stream during the chat exit animation', async () => {
    store.getState().startStreaming('generation', 'assistant', 'swipe')
    const status = deferred<GenerationStatusResponse>()
    getStatus = mock(() => status.promise)
    const recovery = recoverPooledGeneration('chat')
    store.getState().pauseStreamingForNavigation()
    status.resolve(active)
    await recovery

    expect(store.getState().streamingNavigationPaused).toBe(true)
    expect(store.getState().streamingSwipeId).toBeNull()
    expect(store.getState().messages).toEqual([original])
  })

  test('ignores a poll after a newer generation has both started and finished', async () => {
    const status = deferred<GenerationStatusResponse>()
    getStatus = mock(() => status.promise)
    const recovery = recoverPooledGeneration('chat')
    store.getState().beginStreaming()
    store.getState().startStreaming('next')
    store.getState().endStreaming()
    const current = store.getState()
    status.resolve(completed)
    await recovery
    expect(store.getState()).toBe(current)
    expect(list).not.toHaveBeenCalled()
  })

  test('ignores a message refresh after a newer generation has both started and finished', async () => {
    const fresh = deferred<PaginatedResult<Message>>()
    const requested = deferred<void>()
    list = mock(() => { requested.resolve(); return fresh.promise })
    const recovery = recoverPooledGeneration('chat')
    await requested.promise
    store.getState().beginStreaming()
    store.getState().startStreaming('next')
    store.getState().endStreaming()
    const current = store.getState()
    fresh.resolve({ data: [], total: 0, offset: 0, limit: 50 })
    await recovery
    expect(store.getState()).toBe(current)
  })

  test('an in-flight active poll cannot restore buffers after a terminal row was adopted', async () => {
    store.getState().startStreaming('generation', undefined, 'continue')
    const status = deferred<GenerationStatusResponse>()
    getStatus = mock(() => status.promise)
    const recovery = recoverPooledGeneration('chat')
    const edited = { ...original, content: 'Completed with status', swipes: ['Completed with status'], revision: 3 }
    store.getState().markGenerationEnded('generation')
    store.getState().endStreaming(edited)
    const current = store.getState()
    status.resolve({ ...active, generationType: 'continue' })
    await recovery
    expect(store.getState()).toBe(current)
    expect(store.getState().messages[0]).toEqual(edited)
    expect(store.getState().getStreamBuffers()).toEqual({ content: '', reasoning: '' })
  })
})
