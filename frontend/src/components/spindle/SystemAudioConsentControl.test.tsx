import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import shared from '@/i18n/locales/en/shared.json'

const state = { user: { id: 'alice' } }
mock.module('@/store', () => ({ useStore: (select: (store: typeof state) => unknown) => select(state) }))
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
  Node: dom.window.Node, navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const i18n = createInstance()
let createRoot: typeof import('react-dom/client').createRoot
let Control: typeof import('./SystemAudioConsentControl').default
let consent: typeof import('@/lib/spindle/system-audio-consent').systemAudioConsent
let root: Root | null = null
let host: HTMLDivElement | null = null
let nextId = 0

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { shared } } })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: Control } = await import('./SystemAudioConsentControl'))
  ;({ systemAudioConsent: consent } = await import('@/lib/spindle/system-audio-consent'))
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function render(extensionId: string, granted = true) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(I18nextProvider, { i18n }, createElement(Control, { extensionId, granted })))
  })
}
const button = (text: string) => [...document.querySelectorAll('button')].find(button => button.textContent === text)!

test('shows default consent without granting it through the settings control', async () => {
  await render(`control-${++nextId}`)
  expect(host!.textContent).toContain('Ask on every start.')
  expect(document.querySelectorAll('button')).toHaveLength(0)
})

test('revokes remembered approval and requires an explicit action before requests are allowed again', async () => {
  const id = `control-${++nextId}`
  consent.remember('alice', id)
  await render(id)
  expect(host!.textContent).toContain('Approval is remembered')
  act(() => button('Revoke approval').click())
  expect(host!.textContent).toContain('Starts are paused')
  expect(consent.read('alice', id)).toEqual({ remembered: false, paused: true })
  act(() => button('Allow requests again').click())
  expect(host!.textContent).toContain('Ask on every start.')
})

test('resuming after Stop keeps approval, and cannot override a withdrawn system_audio permission', async () => {
  const id = `control-${++nextId}`
  consent.remember('alice', id)
  consent.pause('alice', id)
  await render(id, false)
  expect(button('Allow requests again').disabled).toBe(true)
  await act(async () => {
    root!.render(createElement(I18nextProvider, { i18n }, createElement(Control, { extensionId: id, granted: true })))
  })
  act(() => button('Allow requests again').click())
  expect(consent.read('alice', id)).toEqual({ remembered: true, paused: false })
  expect(host!.textContent).toContain('Approval is remembered')
})
