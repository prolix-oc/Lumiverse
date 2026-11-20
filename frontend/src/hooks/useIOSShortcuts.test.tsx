import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.example/chat/chat-alice' })
const keys = ['window', 'document', 'navigator', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT']
const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
  navigator: dom.window.navigator, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { configurable: true, value })
}
let calls: unknown[], pending: unknown, delayed: ((value: unknown) => void) | null
const navigate = (path: string) => calls.push(['navigate', path])
const state = {
  isAuthenticated: true, user: { id: 'alice' } as { id: string } | null,
  settingsLoaded: true, activeChatId: 'chat-alice' as string | null,
  setSearchQuery: (query: string) => calls.push(['search', query]),
  clearTagFilters: () => calls.push(['clear-tags']),
  setSetting: (key: string, value: string) => calls.push(['setting', key, value]),
}
mock.module('react-router', () => ({ useNavigate: () => navigate }))
mock.module('@/store', () => ({ useStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
  getState: () => state,
}) }))
const { useIOSShortcuts } = await import('./useIOSShortcuts')
const ticket = { id: '11111111-1111-4111-8111-111111111111', action: 'resume-chat' }
let root: Root, container: HTMLDivElement
function Host() { useIOSShortcuts(); return <textarea defaultValue="Unsent draft" /> }
const render = async () => { await act(async () => { root.render(<Host />) }) }
beforeEach(() => {
  calls = []; pending = null; delayed = null
  Object.assign(state, { isAuthenticated: true, user: { id: 'alice' }, settingsLoaded: true, activeChatId: 'chat-alice' })
  dom.window.localStorage.clear()
  Object.assign(dom.window, { __LUMIVERSE_MOBILE__: true, __LUMIVERSE_PLATFORM__: 'ios',
    __LUMIVERSE_IOS_NATIVE__: { version: 1, request(action: string, payload?: { id: string }) {
      calls.push(['native', action])
      if (action === 'shortcuts.pending') return Promise.resolve(pending)
      if ((pending as { id?: string })?.id === payload?.id) pending = null
      return Promise.resolve({ acknowledged: true })
    } } })
  container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
afterAll(() => {
  dom.window.close()
  originals.forEach((descriptor, key) => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  })
})

test('waits for sign-in and settings, then opens an unfiltered favorites view', async () => {
  pending = { ...ticket, action: 'favorites' }
  state.isAuthenticated = false; state.user = null; state.settingsLoaded = false
  await render()
  expect(calls).toEqual([])
  state.isAuthenticated = true; state.user = { id: 'alice' }
  await render()
  expect(calls).toEqual([])
  state.settingsLoaded = true
  await render()
  expect(calls).toEqual([
    ['native', 'shortcuts.pending'], ['search', ''], ['clear-tags'],
    ['setting', 'filterTab', 'favorites'], ['navigate', '/characters'], ['native', 'shortcuts.ack'],
  ])
})
test('resuming an already visible chat preserves its draft without routing again', async () => {
  pending = ticket
  await render()
  expect(calls.filter(call => (call as string[])[0] === 'navigate')).toEqual([])
  expect(container.querySelector('textarea')?.value).toBe('Unsent draft')
  expect(dom.window.localStorage.getItem('lumiverse.ios.last-chat.v1:alice')).toBe('chat-alice')
})
test('uses only the current account history and falls back to Home when none exists', async () => {
  state.user = { id: 'bob' }; state.activeChatId = null
  dom.window.localStorage.setItem('lumiverse.ios.last-chat.v1:alice', 'private-alice-chat')
  pending = ticket
  await render()
  expect(calls).toContainEqual(['navigate', '/'])
  expect(JSON.stringify(calls)).not.toContain('private-alice-chat')
})
test('logout cancels a pending native response before it can navigate or acknowledge', async () => {
  Object.assign(dom.window, { __LUMIVERSE_IOS_NATIVE__: { version: 1, request() {
    return new Promise(resolve => { delayed = resolve })
  } } })
  await render()
  state.isAuthenticated = false; state.user = null
  await render()
  await act(async () => { delayed?.(ticket) })
  expect(calls).toEqual([])
})
