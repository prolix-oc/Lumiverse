import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import type { RequestHistoryEntry, RequestHistoryState } from '@/api/request-history'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/', pretendToBeVisual: true })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { createRoot } = await import('react-dom/client')
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
const row: RequestHistoryEntry = {
  id: 'request-1', sentAt: 1_700_000_000_000, provider: 'google', model: 'example',
  origin: { kind: 'extension', name: 'Example extension', operation: 'quiet' },
  bodyBytes: 45, redacted: true, bodyJson: '{\n  "contents": [],\n  "api_key": "[REDACTED]"\n}',
  response: { state: 'failed', status: 503, completedAt: 1_700_000_000_001, bodyBytes: 30, redacted: true, format: 'json' },
  responseBody: '{"error":{"message":"upstream failed","api_key":"[REDACTED]"}}', responseError: null,
}
let currentEntry: RequestHistoryEntry
let state: RequestHistoryState
let pendingBody: Promise<RequestHistoryEntry> | null = null
const list = mock(async () => structuredClone(state))
const get = mock(async () => pendingBody ?? structuredClone(currentEntry))
const setTracking = mock(async (enabled: boolean) => {
  state = { ...state, enabled, entries: enabled ? state.entries : [] }
  return structuredClone(state)
})
const clear = mock(async () => {
  state = { ...state, entries: [] }
  return structuredClone(state)
})
const copy = mock(async (_text: string) => {})
mock.module('@/api/request-history', () => ({ requestHistoryApi: { list, get, setTracking, clear } }))
mock.module('@/lib/clipboard', () => ({ copyTextToClipboard: copy }))
const { default: RequestHistory } = await import('./RequestHistory')
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
const click = async (element: Element | null) => {
  expect(element).not.toBeNull()
  await act(async () => { (element as HTMLElement).click() })
}
const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label) ?? null

beforeEach(async () => {
  currentEntry = structuredClone(row)
  const { bodyJson: _body, responseBody: _response, responseError: _error, ...summary } = row
  state = { enabled: true, limit: 20, entries: [summary] }
  pendingBody = null
  for (const fn of [list, get, setTracking, clear, copy]) fn.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<RequestHistory />) })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

test('loads bodies only on expansion and copies the exact sanitized JSON', async () => {
  expect(get).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Example extension')
  expect(container.querySelector('time')?.getAttribute('datetime')).toBe(new Date(row.sentAt).toISOString())
  await click(container.querySelector('[aria-expanded="false"]'))
  expect(get).toHaveBeenCalledTimes(1)
  expect(container.querySelector('code')?.textContent).toBe(row.bodyJson)
  await click(button('requestHistory.copy'))
  expect(copy).toHaveBeenCalledWith(row.bodyJson)
  expect(container.textContent).toContain('requestHistory.copied')
  await click(container.querySelector('[aria-expanded="true"]'))
  expect(container.querySelector('code')).toBeNull()
})

test('disabling removes rows and prevents an in-flight body response from restoring them', async () => {
  let resolveBody!: (value: RequestHistoryEntry) => void
  pendingBody = new Promise((resolve) => { resolveBody = resolve })
  await click(container.querySelector('[aria-expanded="false"]'))
  await click(container.querySelector('[role="switch"]'))
  expect(setTracking).toHaveBeenCalledWith(false)
  await act(async () => resolveBody(row))
  expect(container.querySelector('code')).toBeNull()
  expect(container.textContent).not.toContain('Example extension')
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
})

test('clearing removes expanded bodies while leaving tracking enabled', async () => {
  await click(container.querySelector('[aria-expanded="false"]'))
  await click(button('requestHistory.clear'))
  expect(clear).toHaveBeenCalledTimes(1)
  expect(container.querySelector('code')).toBeNull()
  expect(container.textContent).toContain('requestHistory.empty')
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
})

test('failed clipboard writes show an error without reporting success', async () => {
  copy.mockImplementationOnce(async () => { throw new Error('denied') })
  await click(container.querySelector('[aria-expanded="false"]'))
  await click(button('requestHistory.copy'))
  expect(container.textContent).toContain('requestHistory.copyFailed')
  expect(container.textContent).not.toContain('requestHistory.copied')
})

test('shows the provider error response beside the request with a separate copy action', async () => {
  await click(container.querySelector('[aria-expanded="false"]'))
  expect(container.textContent).toContain('HTTP 503')
  expect(container.querySelectorAll('code')[1]?.textContent).toBe(row.responseBody)
  await click(button('requestHistory.copyResponse'))
  expect(copy).toHaveBeenCalledWith(row.responseBody)
  expect(container.querySelectorAll('code')[0]?.textContent).toBe(row.bodyJson)
})

test('loads the response even when the request body is unavailable', async () => {
  currentEntry = { ...currentEntry, bodyJson: null, bodyUnavailable: 'too_large' }
  state.entries[0].bodyUnavailable = 'too_large'
  await click(container.querySelector('[aria-expanded="false"]'))
  expect(get).toHaveBeenCalledTimes(1)
  expect(container.querySelector('code')?.textContent).toBe(row.responseBody)
})

test('refreshes an expanded entry when the response finishes', async () => {
  await act(async () => root.unmount())
  currentEntry = { ...currentEntry, response: { state: 'pending', bodyBytes: 0, redacted: false }, responseBody: null }
  state.entries[0].response = currentEntry.response
  root = createRoot(container)
  await act(async () => root.render(<RequestHistory />))
  await click(container.querySelector('[aria-expanded="false"]'))
  expect(container.textContent).toContain('requestHistory.awaitingResponse')
  currentEntry = structuredClone(row)
  state.entries[0].response = row.response
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)) })
  expect(container.querySelectorAll('code')[1]?.textContent).toBe(row.responseBody)
  expect(container.textContent).not.toContain('requestHistory.awaitingResponse')
})
