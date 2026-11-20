import { describe, expect, jest, mock, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'
import ts from 'typescript'
import type { Message } from '@/types/api'
import { selectedPresetHistorySignature } from '@/lib/preset-history'

mock.module('@/api/settings', () => ({ settingsApi: { put: async () => undefined } }))
const { createChatSlice } = await import('@/store/slices/chat')
const source = await Bun.file(new URL('./useWebSocket.ts', import.meta.url)).text()
const file = ts.createSourceFile('useWebSocket.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const functions = new Map<string, string>()
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(file))
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'wsClient.on') {
    functions.set(node.arguments[0].getText(file).replace('EventType.', ''), node.arguments[1].getText(file))
  }
  ts.forEachChild(node, visit)
}
visit(file)

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const original: Message = {
  id: 'assistant', chat_id: 'chat', index_in_chat: 0, is_user: false, name: 'Assistant',
  content: 'Prefix', send_date: 1, swipe_id: 0, swipes: ['Prefix'], swipe_dates: [1],
  extra: {}, parent_message_id: null, branch_id: null, created_at: 1, revision: 1,
}
const saved = { ...original, content: 'Prefix suffix', swipes: ['Prefix suffix'], revision: 2 }
const edited = { ...saved, content: 'Prefix suffix status', swipes: ['Prefix suffix status'], revision: 3,
  extra: { reasoning: 'Saved reasoning', tokenCount: 12 } }
const ended = { chatId: 'chat', generationId: 'generation', messageId: original.id, content: saved.content }

function setup(optimistic = false) {
  const store = createStore<any>()((...args) => ({
    ...createChatSlice(...args), characters: [], imageGeneration: { enabled: false },
    deleteChatHead() {}, updateChatHead() {}, incrementBadgeCount() {},
  }))
  store.getState().setActiveChat('chat')
  store.getState().setMessages([original])
  store.getState().beginStreaming(undefined, 'continue')
  if (!optimistic) store.getState().startStreaming('generation')
  store.getState().setStreamingSwipeId(0)
  store.getState().reconcileStreamContent(' suffix', 0)
  const tail = deferred<any>()
  let pending: Promise<unknown> = Promise.resolve()
  function track(promise: Promise<any>): any {
    pending = promise
    return {
      then: (callback: any) => track(promise.then(callback)),
      catch: (callback: any) => track(promise.catch(callback)),
      finally: (callback: any) => track(promise.finally(callback)),
    }
  }
  const fetchLatestMessages = mock(() => track(tail.promise))
  const dependencies: Record<string, any> = {
    store, useStore: store, fetchLatestMessages, PENDING_METRICS_MAX: 20,
    pendingGenerationMetrics: new Map(), triggerTTSAutoPlay() {}, playNotificationPing() {},
    generateApi: { acknowledge: async () => {} }, syncMultiplayerChatHeadFromStore() {},
    getEmptyGeneratedSwipeTarget: () => null,
    deleteEmptyGeneratedSwipe: async (_target: unknown, messages: Message[]) => messages,
    isLocalStreamPlaceholderId: (id: string) => !!id && id.startsWith('__'),
    invalidateDisplayRegexCacheForMessage: mock(() => {}), sanitizeToastMessage: (value: string) => value,
    invalidateDisplayRegexCacheForPresetHistory: mock(() => {}), selectedPresetHistorySignature,
    toast: { error() {} }, i18n: { t: (key: string) => key },
    document: { hidden: false, visibilityState: 'visible', hasFocus: () => true },
  }
  function invoke(name: string, ...args: unknown[]) {
    const text = functions.get(name)
    if (!text) throw new Error(`Missing source function: ${name}`)
    const compiled = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`const invoke = ${text};`)
    return new Function(...Object.keys(dependencies), `${compiled}; return invoke;`)(...Object.values(dependencies))(...args)
  }
  for (const name of ['isCurrentGeneration', 'withReasoningSnapshot', 'patchMessageReasoningSnapshot', 'applyGenerationMetrics', 'invalidatePresetHistoryForChange']) {
    dependencies[name] = (...args: unknown[]) => invoke(name, ...args)
  }
  const rejections: unknown[] = []
  const receive = (name: string, payload: unknown) => {
    invoke(name, payload)
    void pending.catch((error) => { rejections.push(error) })
  }
  const update = (message: Message = edited) => receive('MESSAGE_EDITED', { chatId: 'chat', message })
  const finish = async (reject = false) => {
    if (reject) tail.reject(new Error('Tail unavailable'))
    else tail.resolve({ data: [saved], total: 1, offset: 0 })
    await pending
    expect(rejections).toEqual([])
  }
  return { store, receive, update, finish, fetchLatestMessages, invalidations: dependencies.invalidateDisplayRegexCacheForMessage,
    historyInvalidations: dependencies.invalidateDisplayRegexCacheForPresetHistory }
}

describe('preset history cache refresh', () => {
  test('refreshes active names while ignoring timing-only updates and inactive swipes', () => {
    const h = setup()
    const generationMetrics = { presetId: 'preset', presetName: 'Original', tps: 1 }
    h.store.getState().updateMessage(original.id, { extra: { generationMetrics,
      generationMetricsBySwipe: [generationMetrics] } })
    const payload = { chatId: 'chat', messageId: original.id, swipeId: 0, generationMetrics }
    h.receive('GENERATION_METRICS_READY', { ...payload, generationMetrics: { ...generationMetrics, tps: 99 } })
    h.receive('GENERATION_METRICS_READY', { ...payload, swipeId: 1, generationMetrics: { presetId: 'other', presetName: 'Inactive' } })
    expect(h.historyInvalidations).not.toHaveBeenCalled()
    h.receive('GENERATION_METRICS_READY', { ...payload, generationMetrics: { ...generationMetrics, presetName: 'Recorded name' } })
    expect(h.historyInvalidations).toHaveBeenCalledTimes(1)
    expect(h.historyInvalidations).toHaveBeenCalledWith('chat')
    expect(h.store.getState().messages[0].extra.generationMetricsBySwipe[0].presetName).toBe('Recorded name')
  })

  test('refreshes names beyond the loaded page and in cached inactive chats', () => {
    const h = setup()
    h.receive('GENERATION_METRICS_READY', { chatId: 'chat', messageId: 'unloaded', swipeId: 0,
      generationMetrics: { presetId: 'preset', presetName: 'Recorded' } })
    h.receive('GENERATION_METRICS_READY', { chatId: 'other', messageId: 'background', swipeId: 0,
      generationMetrics: { presetId: 'preset', presetName: 'Recorded' } })
    expect(h.historyInvalidations.mock.calls).toEqual([['chat'], ['other']])
  })

  test('ignores edits that leave selected attribution unchanged', () => {
    const h = setup()
    h.update()
    expect(h.historyInvalidations).not.toHaveBeenCalled()
    const generationMetrics = { presetId: 'preset', presetName: 'Recorded' }
    h.store.getState().updateMessage(original.id, { extra: { generationMetrics } })
    h.update({ ...edited, extra: { generationMetrics, hidden: true } })
    expect(h.historyInvalidations).toHaveBeenCalledWith('chat')
  })

  test('refreshes stopped partials again after reconciliation', async () => {
    const h = setup()
    h.receive('GENERATION_STOPPED', ended)
    expect(h.historyInvalidations).toHaveBeenCalledWith('chat')
    h.historyInvalidations.mockClear()
    await h.finish()
    expect(h.historyInvalidations).toHaveBeenCalledWith('chat')
  })
})

describe('continuation terminal message ordering', () => {
  test.each([false, true])('adopts a late full row atomically and keeps it after the old tail (optimistic=%s)', async (optimistic) => {
    const h = setup(optimistic)
    h.update(saved as typeof edited)
    expect(h.store.getState().messages[0]).toBe(original)
    h.receive('GENERATION_ENDED', ended)
    const frames: string[] = []
    const unsubscribe = h.store.subscribe((state: any) => {
      frames.push(state.messages[0].content + (state.isStreaming && state.streamingGenerationType === 'continue' ? state.streamingContent : ''))
    })
    h.update()
    expect(h.store.getState().isStreaming).toBe(false)
    expect(h.store.getState().messages[0]).toEqual(edited)
    expect(h.store.getState().getStreamBuffers()).toEqual({ content: '', reasoning: '' })
    expect(frames).toEqual([edited.content])
    await h.finish()
    expect(h.store.getState().messages[0]).toEqual(edited)
    expect(h.store.getState().lastCompletedGenerationType).toBe('continue')
    expect(frames.every((frame) => frame === edited.content)).toBe(true)
    unsubscribe()
  })

  test('retains the selected background swipe and swipe-scoped metadata', async () => {
    const h = setup()
    const incoming = { ...edited, swipe_id: 1, content: 'Other', swipes: [edited.content, 'Other'],
      swipe_dates: [1, 2], extra: { reasoning: 'Other reasoning', tokenCount: 7 } }
    h.store.getState().updateMessage(original.id, { ...original, ...incoming, revision: 1 })
    h.receive('GENERATION_ENDED', ended)
    h.update(incoming)
    await h.finish()
    expect(h.store.getState().messages[0]).toEqual(incoming)
  })

  test('cancels an unflushed token when adopting the terminal row', async () => {
    jest.useFakeTimers()
    const setTimeout = window.setTimeout
    window.setTimeout = globalThis.setTimeout
    try {
      const h = setup()
      h.store.getState().appendStreamToken(' pending', 7)
      h.receive('GENERATION_ENDED', ended)
      h.update()
      const current = h.store.getState()
      jest.runAllTimers()
      expect(h.store.getState()).toBe(current)
      expect(h.store.getState().getStreamBuffers().content).toBe('')
      await h.finish()
      expect(h.store.getState().streamingContent).toBe('')
    } finally {
      window.setTimeout = setTimeout
      jest.useRealTimers()
    }
  })

  test('finishes a continuation with an explicit message target', async () => {
    const h = setup()
    h.store.getState().setRegeneratingMessageId(original.id)
    h.receive('GENERATION_ENDED', ended)
    h.update()
    expect(h.store.getState().isStreaming).toBe(false)
    await h.finish()
    expect(h.store.getState().messages[0]).toEqual(edited)
  })

  test('does not suppress edits to earlier messages during a continuation', () => {
    const h = setup()
    const user = { ...original, id: 'user', is_user: true, index_in_chat: -1 }
    h.store.getState().prependMessages([user])
    h.receive('MESSAGE_EDITED', { chatId: 'chat', message: { ...user, content: 'Edited user' } })
    expect(h.store.getState().messages[0].content).toBe('Edited user')
    expect(h.store.getState().isStreaming).toBe(true)
  })

  test('peer success and subsequent edits never fetch an owner-only tail', () => {
    const h = setup()
    h.store.setState({ mpRoomId: 'room', mpIsHost: false, mpChatId: 'chat' })
    h.receive('GENERATION_ENDED', ended)
    h.update()
    expect(h.store.getState().messages[0]).toEqual(edited)
    expect(h.store.getState().isStreaming).toBe(false)
    expect(h.fetchLatestMessages).not.toHaveBeenCalled()
  })

  test('keeps deferred metrics delivered after the authoritative edit', async () => {
    const h = setup()
    h.receive('GENERATION_ENDED', ended)
    h.update()
    h.receive('GENERATION_METRICS_READY', { ...ended, swipeId: 0, tokenCount: 18 })
    await h.finish()
    expect(h.store.getState().messages[0]).toMatchObject({ content: edited.content,
      extra: { reasoning: 'Saved reasoning', tokenCount: 18 } })
  })

  for (const terminal of ['GENERATION_ENDED', 'GENERATION_STOPPED'] as const) {
    test.each([false, true])(`${terminal} tail cannot affect a newer optimistic generation (reject=%s)`, async (reject) => {
      const h = setup()
      h.receive(terminal, ended)
      h.update()
      h.store.getState().beginStreaming(undefined, 'continue')
      h.store.getState().reconcileStreamContent(' next', 0)
      const current = h.store.getState()
      await h.finish(reject)
      expect(h.store.getState()).toBe(current)
    })

    test(`${terminal} tail cannot affect a newer generation that also finished`, async () => {
      const h = setup()
      h.receive(terminal, ended)
      h.update()
      h.store.getState().beginStreaming(undefined, 'continue')
      h.store.getState().startStreaming('next')
      h.store.getState().endStreaming()
      const current = h.store.getState()
      await h.finish()
      expect(h.store.getState()).toBe(current)
    })

    test(`${terminal} tail cannot affect a chat opened again after navigation`, async () => {
      const h = setup()
      h.receive(terminal, ended)
      h.store.getState().setActiveChat('other')
      h.store.getState().setActiveChat('chat')
      h.store.getState().setMessages([edited])
      const current = h.store.getState()
      await h.finish()
      expect(h.store.getState()).toBe(current)
    })

    test(`${terminal} tail cannot write into a paused navigation frame`, async () => {
      const h = setup()
      h.receive(terminal, ended)
      h.store.getState().pauseStreamingForNavigation()
      const current = h.store.getState()
      await h.finish()
      expect(h.store.getState()).toBe(current)
    })
  }

  test('a stop-window edit preserves the previous completed generation type', async () => {
    const h = setup()
    h.store.setState({ lastCompletedGenerationType: 'impersonate' })
    h.receive('GENERATION_STOPPED', ended)
    h.update()
    expect(h.store.getState().isStreaming).toBe(false)
    expect(h.store.getState().lastCompletedGenerationType).toBe('impersonate')
    await h.finish()
    expect(h.store.getState().messages[0]).toEqual(edited)
    expect(h.store.getState().lastCompletedGenerationType).toBe('impersonate')
  })

  test('a normal generation clears an earlier impersonation marker and repeated completion is idempotent', () => {
    const h = setup()
    h.store.getState().endStreaming()
    h.store.setState({ lastCompletedGenerationType: 'impersonate' })
    h.store.getState().beginStreaming()
    h.store.getState().startStreaming('normal')
    h.store.getState().endStreaming()
    expect(h.store.getState().lastCompletedGenerationType).toBeNull()
    h.store.getState().endStreaming()
    expect(h.store.getState().lastCompletedGenerationType).toBeNull()
  })

  test('bounds terminal history for success, stop and errors', () => {
    const h = setup()
    for (let i = 0; i < 24; i++) {
      h.store.getState().startStreaming(`generation-${i}`)
      if (i % 3 === 0) h.store.getState().endStreaming()
      else if (i % 3 === 1) h.store.getState().stopStreaming()
      else h.store.getState().setStreamingError('Failure')
    }
    expect(h.store.getState().hasGenerationEnded('generation-3')).toBe(false)
    expect(h.store.getState().hasGenerationEnded('generation-4')).toBe(true)
    expect(h.store.getState().hasGenerationEnded('generation-23')).toBe(true)
  })

  test('an error-tail completion cannot clear a newer stream', async () => {
    const h = setup()
    h.receive('GENERATION_ENDED', { ...ended, error: 'Provider failed' })
    h.store.getState().beginStreaming(undefined, 'continue')
    const current = h.store.getState()
    await h.finish()
    expect(h.store.getState()).toBe(current)
  })

  test.each(['GENERATION_ENDED', 'GENERATION_STOPPED'])('ignores %s for an already-ended generation during a new optimistic start', (terminal) => {
    const h = setup()
    h.store.getState().endStreaming()
    h.store.getState().beginStreaming(undefined, 'continue')
    const current = h.store.getState()
    h.receive(terminal, ended)
    expect(h.store.getState()).toBe(current)
    expect(h.fetchLatestMessages).not.toHaveBeenCalled()
  })

  test('a background stop cannot claim the foreground optimistic generation', () => {
    const h = setup(true)
    const current = h.store.getState()
    h.receive('GENERATION_STOPPED', { chatId: 'other', generationId: 'background' })
    expect(h.store.getState()).toBe(current)
    expect(h.fetchLatestMessages).not.toHaveBeenCalled()
  })
})


test('hidden-swipe edits reuse the selected preset rendering; selected and vanilla edits still invalidate', () => {
  const h = setup(); h.store.getState().endStreaming();
  const message = { ...original, extra: { spindle_metadata: { preset_contexts: [{ preset_id: 'source' }, { preset_id: 'other' }] } }, swipes: ['Prefix', 'sibling'] };
  h.store.getState().setMessages([message]);
  h.update({ ...message, swipes: ['Prefix', 'sibling grows'], revision: 2 });
  expect(h.invalidations).not.toHaveBeenCalled();
  h.update({ ...message, content: 'Selected grows', swipes: ['Selected grows', 'sibling grows'], revision: 3 });
  expect(h.invalidations).toHaveBeenCalledTimes(1);
  h.update({ ...message, extra: { spindle_metadata: { preset_contexts: [{ preset_id: 'changed' }] } }, revision: 4 });
  expect(h.invalidations).toHaveBeenCalledTimes(2);
  h.store.getState().setMessages([original]); h.update(saved as typeof edited);
  expect(h.invalidations).toHaveBeenCalledTimes(3);
});
