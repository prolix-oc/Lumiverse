import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'

const calls: unknown[][] = []
let rejectSetup = false
mock.module('@tauri-apps/api/core', () => ({ invoke: async (...args: unknown[]) => {
  calls.push(args)
  if (rejectSetup) throw new Error('Native setup is unavailable')
} }))
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const i18n = createInstance()
let createRoot: typeof import('react-dom/client').createRoot
let Control: typeof import('./DesktopCaptureControl').default
let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { shared: {} } } })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: Control } = await import('./DesktopCaptureControl'))
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  calls.length = 0
  rejectSetup = false
  delete (window as any).__TAURI_INTERNALS__
})
async function render(desktop: boolean) {
  if (desktop) (window as any).__TAURI_INTERNALS__ = {}
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(I18nextProvider, { i18n }, createElement(Control))))
}

test('desktop setup sends no source, instance, extension identity or grant over IPC', async () => {
  await render(true)
  await act(async () => host!.querySelector('button')!.click())
  expect(calls).toEqual([['desktop_capture_request_setup']])
})
test('regular browsers expose no desktop setup action', async () => {
  await render(false)
  expect(host!.textContent).toBe('')
  expect(calls).toEqual([])
})
test('native setup failure gives tray recovery and permits retry', async () => {
  rejectSetup = true
  await render(true)
  await act(async () => host!.querySelector('button')!.click())
  expect(host!.textContent).toContain('Open the desktop tray')
  expect(host!.querySelector('button')!.disabled).toBe(false)
})
