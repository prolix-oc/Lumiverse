import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, useEffect, useState } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import panels from '@/i18n/locales/en/panels.json'
import type { NanoGptConnectionSettings, NanoGptModelProviders } from '@/api/nanogpt'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })

const calls: { model: string; connection_id?: string; api_key?: string; api_url?: string }[] = []
let discover: (model: string) => Promise<NanoGptModelProviders>
mock.module('@/api/nanogpt', () => ({ nanoGptApi: { providers: async (input: { model: string }) => {
  calls.push(input)
  return discover(input.model)
} } }))

const fixture: NanoGptModelProviders = {
  canonicalId: 'model', displayName: 'Model', supportsProviderSelection: true,
  defaultPrice: { inputPer1kTokens: 0.0005, outputPer1kTokens: 0.002 },
  providers: [
    { provider: 'novita', displayName: 'Novita', available: true, pricing: { inputPer1kTokens: 0.001, outputPer1kTokens: 0.003 }, effectivePricing: { effective_price: { inputPer1kTokens: 0.0008, outputPer1kTokens: 0.0024 } } },
    { provider: 'offline', available: false },
  ],
}

let createRoot: typeof CreateRoot
let Settings: typeof import('./NanoGptSettings').default
let root: Root | undefined
let host: HTMLDivElement
let latest: NanoGptConnectionSettings
let switchModel: (model: string) => void
const i18n = createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { panels } }, interpolation: { escapeValue: false } })
  createRoot = (await import('react-dom/client')).createRoot
  Settings = (await import('./NanoGptSettings')).default
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  calls.length = 0
})

async function render(subscriptionOnly = false, initial: NanoGptConnectionSettings = {}, model = 'model', hasApiKey = true) {
  latest = initial
  discover ||= async () => fixture
  function Harness() {
    const [settings, setSettings] = useState(initial)
    const [selectedModel, setModel] = useState(model)
    useEffect(() => { switchModel = setModel }, [setModel])
    return <I18nextProvider i18n={i18n}><Settings settings={settings} onChange={(next) => { latest = next; setSettings(next) }} model={selectedModel} connectionId="connection" apiKey="" apiUrl="" hasApiKey={hasApiKey} subscriptionOnly={subscriptionOnly} /></I18nextProvider>
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<Harness />) })
}
async function settleDiscovery() { await act(async () => { await Bun.sleep(375) }) }
function sectionToggle() { return host.querySelector<HTMLButtonElement>('button[aria-expanded]')! }
async function expandSettings() { await act(async () => sectionToggle().click()) }
function checkbox(label: string) {
  return [...host.querySelectorAll('label')].find((el) => el.textContent?.includes(label))!.querySelector<HTMLInputElement>('input[type=checkbox]')!
}

test('starts collapsed and shows effective provider prices when expanded without losing settings', async () => {
  discover = async () => fixture
  await render()
  await settleDiscovery()
  expect(calls).toEqual([{ model: 'model', connection_id: 'connection', api_key: undefined, api_url: undefined }])
  expect(sectionToggle().getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('table')).toBeNull()
  expect(host.querySelector('fieldset')).toBeNull()
  await expandSettings()
  expect(sectionToggle().getAttribute('aria-expanded')).toBe('true')
  const rows = [...host.querySelectorAll('tbody tr')]
  expect(rows.find((row) => row.textContent?.includes('Novita'))!.textContent).toContain('$0.8$2.4')
  expect(rows.find((row) => row.textContent?.includes('offline'))!.textContent).toContain('Unavailable')
  expect(host.textContent).toContain('bypass subscription coverage')
  await act(async () => checkbox('Allow provider fallback').click())
  expect(latest.model_overrides?.model?.allow_fallbacks).toBe(false)
  await act(async () => checkbox('Always use pay-as-you-go').click())
  expect(latest.billing_mode).toBe('paygo')
  await act(async () => sectionToggle().click())
  expect(host.querySelector('table')).toBeNull()
  await expandSettings()
  expect(checkbox('Allow provider fallback').checked).toBe(false)
  expect(checkbox('Always use pay-as-you-go').checked).toBe(true)
  expect(calls).toHaveLength(1)
})

test('subscription-only disables paid routing and reset preserves other model preferences', async () => {
  discover = async () => fixture
  await render(true, { model_overrides: { model: { only: ['novita'] }, other: { only: ['other-provider'] } } })
  expect(sectionToggle().getAttribute('aria-expanded')).toBe('false')
  await expandSettings()
  await settleDiscovery()
  expect(checkbox('Always use pay-as-you-go').disabled).toBe(true)
  expect(host.querySelector('fieldset')!.disabled).toBe(true)
  expect(host.textContent).toContain('PAYG routing is inactive')
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === "Reset this model's routing")!.click())
  expect(latest.model_overrides).toEqual({ other: { only: ['other-provider'] } })
})

test('an old discovery response cannot replace the newly selected model', async () => {
  let finishOld!: (value: NanoGptModelProviders) => void
  discover = (model) => model === 'model' ? new Promise((resolve) => { finishOld = resolve }) : Promise.resolve({ canonicalId: 'other', displayName: 'Other', supportsProviderSelection: false, providers: [] })
  await render()
  await expandSettings()
  await settleDiscovery()
  await act(async () => switchModel('other'))
  await settleDiscovery()
  await act(async () => finishOld(fixture))
  expect(host.textContent).toContain('does not support provider selection')
  expect(host.querySelector('table')).toBeNull()
  expect(calls.map((call) => call.model)).toEqual(['model', 'other'])
})

test('discovery failure can be retried without erasing saved routing', async () => {
  discover = async () => { throw { body: { error: 'Provider catalog is temporarily unavailable' } } }
  await render(false, { model_overrides: { model: { only: ['novita'] } } })
  await expandSettings()
  await settleDiscovery()
  expect(host.querySelector('[role=alert]')!.textContent).toBe('Provider catalog is temporarily unavailable')
  expect(latest.model_overrides?.model?.only).toEqual(['novita'])
  discover = async () => fixture
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh available providers"]')!.click())
  await settleDiscovery()
  expect(host.querySelector('[role=alert]')).toBeNull()
  expect(host.querySelector('table')).not.toBeNull()
})

test('missing credentials do not trigger discovery', async () => {
  discover = async () => fixture
  await render(false, {}, 'model', false)
  await expandSettings()
  await settleDiscovery()
  expect(calls).toHaveLength(0)
  expect(host.textContent).toContain('Select a model and enter or save an API key')
})
