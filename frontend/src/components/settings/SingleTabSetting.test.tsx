import { afterAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true })
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }))
const { default: SingleTabSetting } = await import('./SingleTabSetting')
const root = createRoot(document.getElementById('root')!)
afterAll(async () => { await act(async () => root.unmount()); dom.window.close() })

test('setting defaults on, shows warning, saves opt-out and follows another tab', async () => {
  await act(async () => root.render(<SingleTabSetting userId="account" />))
  const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(document.body.textContent).toContain('Warning: having multiple tabs open and accidentally using the wrong one can cause irrecoverable issues in your lumiverse save data. Be warned.')
  expect(document.querySelector('strong')?.textContent).toBe('Warning:')
  expect(document.querySelector('p')?.textContent?.startsWith('Warning:')).toBe(true)
  await act(async () => toggle.click())
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(window.localStorage.getItem('lumiverse:allow-multiple-tabs:account')).toBe('true')
  await act(async () => {
    window.localStorage.removeItem('lumiverse:allow-multiple-tabs:account')
    window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'lumiverse:allow-multiple-tabs:account' }))
  })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
})
