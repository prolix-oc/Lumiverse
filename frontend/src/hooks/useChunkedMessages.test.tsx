import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { create } from 'zustand'
import { JSDOM } from 'jsdom'
import type { Message } from '@/types/api'

const message = (id: string, index = Number(id.slice(1))) => ({ id, index_in_chat: index, content: id, extra: {} }) as Message
const store = create(() => ({
  activeChatId: 'A', messages: [message('m8'), message('m9')], totalChatLength: 10, messagesPerPage: 2,
  prependMessages: (older: Message[]) => store.setState((state) => ({ messages: [...older, ...state.messages] })),
}))
const before = mock((_chatId: string, _boundary: unknown, _limit: number, _options: unknown): Promise<any> => new Promise(() => {}))
const listeners = new Map<string, Set<(payload: any) => void>>()
mock.module('@/store', () => ({ useStore: store }))
mock.module('@/api/chats', () => ({ messagesApi: { before } }))
mock.module('@/ws/client', () => ({ wsClient: { on: (event: string, handler: (payload: any) => void) => {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event)!.add(handler)
  return () => { listeners.get(event)!.delete(handler) }
} } }))
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })
window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any
const { useChunkedMessages } = await import('./useChunkedMessages')
let host: HTMLDivElement, root: Root, current: ReturnType<typeof useChunkedMessages>
function Probe() {
  const messages = store((state) => state.messages), chatId = store((state) => state.activeChatId)
  const loaded = useChunkedMessages(messages, chatId)
  useLayoutEffect(() => { current = loaded })
  return <div>{messages.map((item) => item.id).join(',')}</div>
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  store.setState({ activeChatId: 'A', messages: [message('m8'), message('m9')], totalChatLength: 10 })
  before.mockClear()
  before.mockImplementation(() => new Promise(() => {}))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
async function render() { await act(async () => root.render(<Probe />)) }
async function populated(chatId = 'A') {
  await act(async () => { window.dispatchEvent(new dom.window.CustomEvent('lumiverse:chat-items-populated', { detail: { chatId } })) })
}

test('prefetch waits for display readiness, and scrolling joins its pending cursor request', async () => {
  const response = deferred<any>()
  before.mockImplementationOnce(() => response.promise)
  await render()
  expect(before).not.toHaveBeenCalled()
  await populated('stale')
  expect(before).not.toHaveBeenCalled()
  await populated()
  expect(before).toHaveBeenCalledTimes(1)
  expect(before.mock.calls[0].slice(0, 3)).toEqual(['A', { id: 'm8', index: 8 }, 2])
  await act(async () => current.loadMore())
  expect(current.loadingOlder).toBe(true)
  expect(before).toHaveBeenCalledTimes(1)
  await act(async () => response.resolve({ data: [message('m6'), message('m7')], has_more: true }))
  expect(host.textContent).toBe('m6,m7,m8,m9')
  expect(current.loadingOlder).toBe(false)
  expect(before.mock.calls[1].slice(0, 3)).toEqual(['A', { id: 'm6', index: 6 }, 2])
})

test('A → B → A cancels old work and its completion cannot prepend into the return visit', async () => {
  const old = deferred<any>()
  before.mockImplementationOnce(() => old.promise)
  await render(); await populated()
  await act(async () => current.loadMore())
  const signal = (before.mock.calls[0][3] as { signal: AbortSignal }).signal
  await act(async () => store.setState({ activeChatId: 'B', messages: [message('b', 0)], totalChatLength: 1 }))
  await act(async () => store.setState({ activeChatId: 'A', messages: [message('m8'), message('m9')], totalChatLength: 10 }))
  expect(signal.aborted).toBe(true)
  await act(async () => old.resolve({ data: [message('old', 0)], has_more: false }))
  expect(host.textContent).toBe('m8,m9')
  expect(current.hasMore).toBe(true)
  expect(current.loadingOlder).toBe(false)
})

test('a WS edit or deletion invalidates prefetched rows outside the loaded window', async () => {
  const old = deferred<any>(), fresh = deferred<any>()
  before.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise)
  await render(); await populated()
  await act(async () => { for (const handler of listeners.get('MESSAGE_DELETED')!) handler({ chatId: 'A', messageId: 'm7' }) })
  expect((before.mock.calls[0][3] as { signal: AbortSignal }).signal.aborted).toBe(true)
  await act(async () => current.loadMore())
  await act(async () => {
    old.resolve({ data: [message('m7')], has_more: true })
    fresh.resolve({ data: [message('m0')], has_more: false })
  })
  expect(host.textContent).toBe('m0,m8,m9')
  expect(current.hasMore).toBe(false)
})

test('cursor boundaries use database ordering when tied positions display in date order', async () => {
  store.setState({ messages: [message('z', 8), message('a', 8), message('last', 9)] })
  await render(); await populated()
  expect(before.mock.calls[0].slice(0, 3)).toEqual(['A', { id: 'a', index: 8 }, 2])
})
