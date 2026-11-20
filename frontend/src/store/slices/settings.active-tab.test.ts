import { afterEach, expect, mock, test } from 'bun:test'

const controller = new AbortController()
mock.module('@/lib/active-tab', () => ({ activeTab: {
  signal: controller.signal, assertActive() { controller.signal.throwIfAborted() },
} }))
const { persistKey, flushSettings, resetSettingsPersistence, setSettingsPersistenceScope } = await import('./settings')
const originalFetch = globalThis.fetch
afterEach(() => { resetSettingsPersistence(); setSettingsPersistenceScope(null); globalThis.fetch = originalFetch })

test('inactive-tab unload does not send a keepalive save or retain stale shared recovery data', () => {
  const fetchMock = mock(() => Promise.resolve(new Response('{}')))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  setSettingsPersistenceScope('account')
  persistKey('theme', { accent: '#abcdef' })
  controller.abort(new Error('Tab inactive'))
  const before = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!
    return [key, localStorage.getItem(key)]
  })
  flushSettings()
  expect(fetchMock).not.toHaveBeenCalled()
  expect(Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!
    return [key, localStorage.getItem(key)]
  })).toEqual(before)
})
