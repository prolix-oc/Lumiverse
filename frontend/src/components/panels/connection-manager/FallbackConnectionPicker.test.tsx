import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConnectionProfile } from '@/types/api'

const profile = (id: string, provider = 'openai'): ConnectionProfile => ({
  id, provider, name: id, model: 'model', api_url: '', preset_id: null, is_default: false,
  has_api_key: false, metadata: {}, created_at: 0, updated_at: 0,
})
const primary = profile('primary')
const backup = profile('backup')
const state = { profiles: [primary, backup, profile('roulette', 'model_roulette')] }
mock.module('@/store', () => ({ useStore: (selector: (s: typeof state) => unknown) => selector(state) }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const get = mock(async () => ({ ...primary, metadata: { latest: 'preserved' } }))
const update = mock(async (_id: string, input: { metadata: Record<string, unknown> }) => ({ ...primary, ...input }))
mock.module('@/api/connections', () => ({ connectionsApi: { get, update } }))
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, HTMLSelectElement: dom.window.HTMLSelectElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { default: FallbackConnectionPicker } = await import('./FallbackConnectionPicker')
let root: Root
let host: HTMLElement
const onUpdate = mock(() => {})
const onClose = mock(() => {})
beforeEach(() => {
  get.mockClear(); update.mockClear(); onUpdate.mockClear(); onClose.mockClear()
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })
const render = (current = primary) => act(() => root.render(<FallbackConnectionPicker profile={current} onUpdate={onUpdate} onClose={onClose} />))
const save = async () => act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); await new Promise((r) => setTimeout(r, 0)) })

test('offers owned provider profiles excluding self and roulette, then saves current metadata', async () => {
  render()
  expect(Array.from(host.querySelectorAll('option')).map((o) => o.value)).toEqual(['', 'backup'])
  const select = host.querySelector('select')!
  act(() => { select.value = 'backup'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
  await save()
  expect(update).toHaveBeenCalledWith('primary', { metadata: { latest: 'preserved', fallback_connection_id: 'backup' } })
  expect(onUpdate).toHaveBeenCalledTimes(1)
  expect(onClose).toHaveBeenCalledTimes(1)
})
test('can remove an unavailable fallback', async () => {
  render({ ...primary, metadata: { fallback_connection_id: 'deleted' } })
  const select = host.querySelector('select')!
  expect(select.value).toBe('deleted')
  act(() => { select.value = ''; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
  await save()
  expect(update.mock.calls[0][1].metadata.fallback_connection_id).toBeNull()
})
test('keeps the picker open and shows save errors', async () => {
  update.mockRejectedValueOnce(new Error('Save failed'))
  render()
  await save()
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Save failed')
  expect(onClose).not.toHaveBeenCalled()
  expect(onUpdate).not.toHaveBeenCalled()
})
