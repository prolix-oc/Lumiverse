import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { installIOSShortcuts, lastIOSChat, rememberIOSChat } from './ios-shortcuts'

const originals = new Map(['window', 'document', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const first = { id: '11111111-1111-4111-8111-111111111111', action: 'resume-chat' }
const second = { id: '22222222-2222-4222-8222-222222222222', action: 'favorites' }
let host: EventTarget & { __LUMIVERSE_MOBILE__: boolean; __LUMIVERSE_PLATFORM__: string; __LUMIVERSE_IOS_NATIVE__: unknown }
let pending: unknown, acknowledged: string[], stops: Array<() => void>, values: Map<string, string>
let read: () => Promise<unknown>
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
beforeEach(() => {
  pending = first; acknowledged = []; stops = []; values = new Map()
  read = async () => pending
  host = Object.assign(new EventTarget(), { __LUMIVERSE_MOBILE__: true, __LUMIVERSE_PLATFORM__: 'ios',
    __LUMIVERSE_IOS_NATIVE__: { version: 1, async request(action: string, payload?: { id: string }) {
      if (action === 'shortcuts.pending') return read()
      acknowledged.push(payload!.id)
      if ((pending as { id?: string })?.id === payload!.id) pending = null
      return { acknowledged: true }
    } } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), {
    visibilityState: 'visible', documentElement: { hasAttribute: () => false, getAttribute: () => null },
  }) })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } })
})
afterEach(() => stops.forEach(stop => stop()))
afterAll(() => originals.forEach((descriptor, key) => {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor)
  else Reflect.deleteProperty(globalThis, key)
}))
const emit = () => host.dispatchEvent(new Event('lumiverse:ios-shortcut'))

test('a cold-launch request is handled and acknowledged after the frontend becomes ready', async () => {
  const actions: string[] = []
  stops.push(installIOSShortcuts(action => { actions.push(action); return true }))
  await flush(); emit(); await flush()
  expect(actions).toEqual(['resume-chat'])
  expect(acknowledged).toEqual([first.id])
})
test('a newer request arriving during navigation survives the first acknowledgement', async () => {
  const actions: string[] = []
  stops.push(installIOSShortcuts(action => {
    actions.push(action)
    if (action === 'resume-chat') { pending = second; emit() }
    return true
  }))
  await flush()
  expect(actions).toEqual(['resume-chat', 'favorites'])
  expect(acknowledged).toEqual([first.id, second.id])
})
test('repairs a missed foreground event and does not lose a request behind an empty snapshot', async () => {
  let resolve: (value: unknown) => void = () => {}
  read = () => new Promise(done => { resolve = done })
  const actions: string[] = []
  stops.push(installIOSShortcuts(action => { actions.push(action); return true }))
  read = async () => pending
  emit(); resolve(null); await flush()
  pending = second
  host.dispatchEvent(Object.assign(new Event('lumiverse:ios-app-state'), { detail: { state: 'active' } }))
  await flush()
  expect(actions).toEqual(['resume-chat', 'favorites'])
})
test('does not consume a request after logout or when its account is no longer ready', async () => {
  let resolve: (value: unknown) => void = () => {}
  read = () => new Promise(done => { resolve = done })
  const stop = installIOSShortcuts(() => { throw new Error('Late navigation') })
  stops.push(stop); stop(); resolve(first); await flush()
  expect(acknowledged).toEqual([])
  read = async () => pending
  stops.push(installIOSShortcuts(() => false))
  await flush()
  expect(acknowledged).toEqual([])
})
test('last chat IDs stay separate for each account and reject malformed destinations', () => {
  rememberIOSChat('alice', 'chat-alice'); rememberIOSChat('bob', 'chat-bob')
  rememberIOSChat('alice', null); rememberIOSChat('alice', '../admin')
  expect(lastIOSChat('alice')).toBe('chat-alice')
  expect(lastIOSChat('bob')).toBe('chat-bob')
  expect(lastIOSChat('new-account')).toBeNull()
  values.set('lumiverse.ios.last-chat.v1:alice', 'https://another-server/chat')
  expect(lastIOSChat('alice')).toBeNull()
})
test('ignores malformed requests and other platforms', async () => {
  pending = { ...first, action: 'delete-everything' }
  stops.push(installIOSShortcuts(() => { throw new Error('Invalid action') }))
  await flush()
  expect(acknowledged).toEqual([])
  host.__LUMIVERSE_PLATFORM__ = 'android'
  stops.push(installIOSShortcuts(() => { throw new Error('Wrong platform') }))
})
