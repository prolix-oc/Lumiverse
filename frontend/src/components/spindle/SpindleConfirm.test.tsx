import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import type { PendingConfirmRequest } from '@/types/store'

const answers: unknown[][] = []
const store = {
  pendingConfirm: null as PendingConfirmRequest | null,
  closeSpindleConfirm: (...args: unknown[]) => { answers.push(args) },
}
mock.module('@/store', () => ({ useStore: (select: (state: typeof store) => unknown) => select(store) }))
// Exercise the real confirmation form, without the shared shell's animation timers.
mock.module('@/components/shared/ModalShell', () => ({
  ModalShell: ({ children }: { children: React.ReactNode }) => createElement('div', { role: 'dialog' }, children),
}))
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
  Node: dom.window.Node, navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const i18n = createInstance()
let createRoot: typeof import('react-dom/client').createRoot
let SpindleConfirm: typeof import('./SpindleConfirm').default
let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: {} })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: SpindleConfirm } = await import('./SpindleConfirm'))
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  answers.length = 0
})

const request = (id: string, checkboxLabel?: string): PendingConfirmRequest => ({
  requestId: id, extensionId: id, extensionName: 'Visualizer',
  title: 'Analyse system audio?', message: 'Analysis only.', variant: 'warning',
  confirmLabel: 'Allow', cancelLabel: 'Not now', checkboxLabel,
})

async function render(req: PendingConfirmRequest) {
  store.pendingConfirm = req
  if (!host) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(createElement(I18nextProvider, { i18n }, createElement(SpindleConfirm)))
  })
}

test('remembering consent is unchecked by default and only submitted when explicitly selected', async () => {
  await render(request('a', 'Remember approval'))
  const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement
  expect(checkbox.checked).toBe(false)
  act(() => checkbox.click())
  act(() => document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
  expect(answers).toEqual([['a', true, true]])
})

test('replacing a request resets the checkbox and cancel does not submit remembered approval', async () => {
  await render(request('a', 'Remember approval'))
  act(() => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
  await render(request('b', 'Remember approval'))
  expect((document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false)
  act(() => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
  const cancel = [...document.querySelectorAll('button')].find(button => button.textContent === 'Not now')!
  act(() => cancel.click())
  expect(answers).toEqual([['b', false]])
})

test('ordinary extension confirmations still have no checkbox', async () => {
  await render(request('ordinary'))
  expect(document.querySelector('input[type="checkbox"]')).toBeNull()
  act(() => document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
  expect(answers).toEqual([['ordinary', true, false]])
})
