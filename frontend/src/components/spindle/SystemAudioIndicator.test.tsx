import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import shared from '@/i18n/locales/en/shared.json'

const stops: string[] = []
const store = {
  systemAudioSessions: [] as Array<{ id: string; extensionId: string; extensionName: string; stop: () => void }>,
}
mock.module('@/store', () => ({ useStore: (select: (state: typeof store) => unknown) => select(store) }))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
  Node: dom.window.Node, navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const i18n = createInstance()
let createRoot: typeof import('react-dom/client').createRoot
let SystemAudioIndicator: typeof import('./SystemAudioIndicator').default
let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { shared } } })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: SystemAudioIndicator } = await import('./SystemAudioIndicator'))
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  store.systemAudioSessions = []
  stops.length = 0
})

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(I18nextProvider, { i18n }, createElement(SystemAudioIndicator)))
    await Promise.resolve()
  })
}

const indicator = () => document.querySelector('[data-testid="system-audio-indicator"]')

test('shows nothing while no extension is analysing system audio', async () => {
  await render()
  expect(indicator()).toBeNull()
})

test('names every extension that is listening and lets the user stop each one', async () => {
  store.systemAudioSessions = [
    { id: 'a', extensionId: 'ext-a', extensionName: 'Lumi Flair', stop: () => stops.push('a') },
    { id: 'b', extensionId: 'ext-b', extensionName: 'Other Ext', stop: () => stops.push('b') },
  ]
  await render()
  const el = indicator()!
  expect(el.getAttribute('role')).toBe('status')
  expect(el.textContent).toContain('Lumi Flair is analysing system audio')
  expect(el.textContent).toContain('Other Ext is analysing system audio')
  const buttons = [...el.querySelectorAll('button')].filter((b) => b.textContent === 'Stop')
  expect(buttons).toHaveLength(2)
  act(() => buttons[1].click())
  expect(stops).toEqual(['b'])
})

test('is rendered outside the app tree, so an extension’s DOM cannot cover or hide it from inside', async () => {
  store.systemAudioSessions = [{ id: 'a', extensionId: 'ext-a', extensionName: 'Lumi Flair', stop: () => {} }]
  await render()
  expect(host!.contains(indicator())).toBe(false)
  expect(indicator()!.parentElement).toBe(document.body)
})

const two = () => [
  { id: 'a', extensionId: 'ext-a', extensionName: 'Lumi Flair', stop: () => stops.push('a') },
  { id: 'b', extensionId: 'ext-b', extensionName: 'Other Ext', stop: () => stops.push('b') },
]
/** Press the first Minimise button (the first expanded pill's). */
const minimise = (_name: string) =>
  act(() => {
    ;(document.querySelector('[aria-label="Minimise"]') as HTMLButtonElement).click()
  })
const chips = () => [...document.querySelectorAll('[data-testid="system-audio-chip"]')] as HTMLButtonElement[]

test('the user can minimise a session to a small chip, which still shows that something is listening', async () => {
  store.systemAudioSessions = [two()[0]]
  await render()
  expect(indicator()!.textContent).toContain('Lumi Flair is analysing system audio')
  minimise('Lumi Flair')
  expect(indicator()).not.toBeNull() // never removed
  expect(indicator()!.textContent).not.toContain('analysing')
  expect(chips()).toHaveLength(1)
  expect(chips()[0].getAttribute('aria-label')).toBe('Show: Lumi Flair is analysing system audio')
  expect(chips()[0].textContent).toBe('♪')
  expect(indicator()!.getAttribute('role')).toBe('status')
})

test('a chip opens the full pill again, and Stop still works from it', async () => {
  store.systemAudioSessions = [two()[0]]
  await render()
  minimise('Lumi Flair')
  act(() => chips()[0].click())
  expect(chips()).toHaveLength(0)
  const stop = [...indicator()!.querySelectorAll('button')].find((b) => b.textContent === 'Stop')!
  act(() => stop.click())
  expect(stops).toEqual(['a'])
})

test('minimising one session leaves the others in full view', async () => {
  store.systemAudioSessions = two()
  await render()
  minimise('first') // the first pill's button
  expect(chips()).toHaveLength(1)
  expect(indicator()!.textContent).toContain('Other Ext is analysing system audio')
  expect(indicator()!.textContent).not.toContain('Lumi Flair is analysing system audio')
})

test('a session that starts after another was minimised starts expanded', async () => {
  store.systemAudioSessions = [two()[0]]
  await render()
  minimise('Lumi Flair')
  store.systemAudioSessions = two()
  await act(async () => {
    root!.render(createElement(I18nextProvider, { i18n }, createElement(SystemAudioIndicator)))
    await Promise.resolve()
  })
  expect(chips()).toHaveLength(1)
  expect(indicator()!.textContent).toContain('Other Ext is analysing system audio')
})

test('a minimised session that ends takes its chip with it, and a new one is not born minimised', async () => {
  store.systemAudioSessions = [two()[0]]
  await render()
  minimise('Lumi Flair')
  store.systemAudioSessions = []
  await act(async () => {
    root!.render(createElement(I18nextProvider, { i18n }, createElement(SystemAudioIndicator)))
    await Promise.resolve()
  })
  expect(indicator()).toBeNull()
  store.systemAudioSessions = [{ id: 'c', extensionId: 'ext-a', extensionName: 'Lumi Flair', stop: () => {} }]
  await act(async () => {
    root!.render(createElement(I18nextProvider, { i18n }, createElement(SystemAudioIndicator)))
    await Promise.resolve()
  })
  expect(chips()).toHaveLength(0)
  expect(indicator()!.textContent).toContain('Lumi Flair is analysing system audio')
})
