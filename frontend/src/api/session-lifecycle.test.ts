/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('', { url: 'http://localhost/' })
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event })

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('signals the auth guard when an API request receives a 401', async () => {
  const { AUTH_SESSION_INVALID_EVENT } = await import('./session-lifecycle')
  const { get, ApiError } = await import('./client')
  let signals = 0
  window.addEventListener(AUTH_SESSION_INVALID_EVENT, () => { signals += 1 }, { once: true })
  globalThis.fetch = mock(async () => new Response(
    JSON.stringify({ error: 'Unauthorized', code: 'SESSION_EXPIRED' }),
    { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch

  await expect(get('/settings')).rejects.toBeInstanceOf(ApiError)
  expect(signals).toBe(1)
})

test('does not confuse an integration credential failure with an app session expiry', async () => {
  const { AUTH_SESSION_INVALID_EVENT } = await import('./session-lifecycle')
  const { get, ApiError } = await import('./client')
  let signals = 0
  window.addEventListener(AUTH_SESSION_INVALID_EVENT, () => { signals += 1 }, { once: true })
  globalThis.fetch = mock(async () => new Response(
    JSON.stringify({ error: 'Not authorized. Connect Google Drive first.' }),
    { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch

  await expect(get('/operator')).rejects.toBeInstanceOf(ApiError)
  expect(signals).toBe(0)
})
