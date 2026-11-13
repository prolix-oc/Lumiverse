import { beforeEach, describe, expect, mock, test } from 'bun:test'

const calls: unknown[][] = []
let generationEpoch = 0
let stopCompletion: Promise<void> | undefined
const store = {
  activeChatId: 'chat-1' as string | null,
  activeGenerationId: null as string | null,
  isStreaming: false,
  mpRoomId: null as string | null,
  mpIsHost: false,
  messages: [] as Array<{ id: string; is_user: boolean }>,
  stopStreaming: () => { calls.push(['stopStreaming']) },
  getGenerationEpoch: () => generationEpoch,
}

mock.module('@/store', () => ({
  useStore: Object.assign(() => store, { getState: () => store, subscribe: () => () => {} }),
}))
mock.module('@/api/generate', () => ({
  generateApi: { stop: async (...args: unknown[]) => { calls.push(['stop', ...args]); await stopCompletion } },
}))
mock.module('@/hooks/useSwipeAction', () => ({
  executeSwipe: async (message: { id: string }, chatId: string, direction: string, options?: { background: boolean }) => {
    calls.push(options ? ['swipe', message.id, chatId, direction, options] : ['swipe', message.id, chatId, direction])
  },
}))

mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))
mock.module('@/lib/drawer-tab-registry', () => ({ DRAWER_TABS: [], registryToCommands: () => [] }))
mock.module('@/lib/settings-tab-registry', () => ({ getVisibleSettingsTabs: () => [], settingsRegistryToCommands: () => [] }))

const { COMMANDS } = await import('./commands')
const run = (id: string) => COMMANDS.find((command) => command.id === id)!.run(() => {})

beforeEach(() => {
  calls.length = 0
  generationEpoch = 0
  stopCompletion = undefined
  Object.assign(store, { activeChatId: 'chat-1', activeGenerationId: null, isStreaming: false, mpRoomId: null, mpIsHost: false, messages: [] })
})

describe('generation-control commands', () => {
  test('stop asks the backend to stop every generation of the active chat', async () => {
    Object.assign(store, { isStreaming: true, activeGenerationId: 'gen-1' })
    await run('action-stop-generation')
    expect(calls).toEqual([['stop', undefined, 'chat-1']])
  })

  test('stop reverts the optimistic stream that has no generation id yet', async () => {
    store.isStreaming = true
    await run('action-stop-generation')
    expect(calls).toEqual([['stop', undefined, 'chat-1'], ['stopStreaming']])
  })

  test('a delayed stop does not clear the stream of another chat', async () => {
    let completeStop!: () => void
    stopCompletion = new Promise<void>((resolve) => { completeStop = resolve })
    store.isStreaming = true
    const stopping = run('action-stop-generation')
    store.activeChatId = 'chat-2'
    generationEpoch++
    completeStop()
    await stopping
    expect(calls).toEqual([['stop', undefined, 'chat-1']])
  })

  test('a delayed stop does not clear a newer optimistic generation in the same chat', async () => {
    let completeStop!: () => void
    stopCompletion = new Promise<void>((resolve) => { completeStop = resolve })
    store.isStreaming = true
    const stopping = run('action-stop-generation')
    generationEpoch++
    completeStop()
    await stopping
    expect(calls).toEqual([['stop', undefined, 'chat-1']])
  })

  test('stop leaves an identified stream to finish through its generation events', async () => {
    let completeStop!: () => void
    stopCompletion = new Promise<void>((resolve) => { completeStop = resolve })
    store.isStreaming = true
    const stopping = run('action-stop-generation')
    store.activeGenerationId = 'gen-1'
    completeStop()
    await stopping
    expect(calls).toEqual([['stop', undefined, 'chat-1']])
  })

  test('stop does nothing for a room peer or without a chat', async () => {
    Object.assign(store, { mpRoomId: 'room-1', mpIsHost: false })
    await run('action-stop-generation')
    Object.assign(store, { mpRoomId: null, activeChatId: null })
    await run('action-stop-generation')
    expect(calls).toEqual([])
  })

  test('swipes target the last assistant message', async () => {
    store.messages = [
      { id: 'a-1', is_user: false },
      { id: 'a-2', is_user: false },
      { id: 'u-1', is_user: true },
    ]
    await run('action-swipe-left')
    await run('action-swipe-right')
    expect(calls).toEqual([['swipe', 'a-2', 'chat-1', 'left'], ['swipe', 'a-2', 'chat-1', 'right']])
  })

  test('background command requests a non-selecting native swipe', async () => {
    store.messages = [{ id: 'a-1', is_user: false }]
    await run('action-background-swipe')
    expect(calls).toEqual([['swipe', 'a-1', 'chat-1', 'right', { background: true }]])
  })

  test('swipes do nothing without an assistant message', async () => {
    store.messages = [{ id: 'u-1', is_user: true }]
    await run('action-swipe-right')
    expect(calls).toEqual([])
  })
})
