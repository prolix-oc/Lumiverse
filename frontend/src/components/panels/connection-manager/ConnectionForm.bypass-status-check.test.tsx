import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import panels from '@/i18n/locales/en/panels.json'
import type { ConnectionProfile, CreateConnectionProfileInput } from '@/types/api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, sessionStorage: dom.window.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })

mock.module('@/api/connections', () => ({ connectionsApi: { previewModels: async () => ({ models: ['gemini-2.5-pro'] }) } }))
const store = {
  profiles: [] as ConnectionProfile[], reasoningSettings: {}, promptBias: '', fullSettingsLoaded: true,
  connectionLibraries: { llm: { folders: [], folderOrder: [''], assignments: {} as Record<string, string> } },
  setSetting: (_key: string, value: typeof store.connectionLibraries) => { store.connectionLibraries = value },
}
const useStore = Object.assign((selector: (value: typeof store) => unknown) => selector(store), { getState: () => store })
mock.module('@/store', () => ({ useStore }))

let createRoot: typeof CreateRoot
let Form: typeof import('./ConnectionForm').default
let root: Root | undefined
let host: HTMLDivElement
const i18n = createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { panels } }, interpolation: { escapeValue: false } })
  createRoot = (await import('react-dom/client')).createRoot
  Form = (await import('./ConnectionForm')).default
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
})

async function mount(element: ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>) })
}
function profileWith(metadata: Record<string, unknown>, provider = 'google'): ConnectionProfile {
  return {
    id: 'proxy', name: 'Proxy', provider, api_url: 'https://proxy.example.test', model: 'gemini-2.5-pro',
    has_api_key: true, is_default: false, preset_id: null, metadata, created_at: 0, updated_at: 0,
  }
}
function bypassCheckbox(): HTMLInputElement | null {
  const label = [...host.querySelectorAll('label')].find((element) => element.textContent?.includes(panels.connectionForm.bypassStatusCheck))
  return label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null
}
async function toggleBypass() { await act(async () => bypassCheckbox()!.click()) }
async function save() {
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === panels.connectionForm.save)!.click())
}

test('enabling the bypass saves bypass_status_check and keeps other metadata', async () => {
  const saves: CreateConnectionProfileInput[] = []
  await mount(<Form providers={[]} profile={profileWith({ custom_flag: 'kept' })} onSave={(value) => saves.push(value)} onCancel={() => {}} />)
  expect(bypassCheckbox()?.checked).toBe(false)
  await toggleBypass()
  await save()
  expect(saves[0]?.metadata).toEqual({ custom_flag: 'kept', bypass_status_check: true })
})

test('a saved bypass loads checked and clearing it removes the key', async () => {
  const saves: CreateConnectionProfileInput[] = []
  await mount(<Form providers={[]} profile={profileWith({ bypass_status_check: true })} onSave={(value) => saves.push(value)} onCancel={() => {}} />)
  expect(bypassCheckbox()?.checked).toBe(true)
  await toggleBypass()
  await save()
  expect(saves[0]?.metadata).not.toHaveProperty('bypass_status_check')
})

test('the toggle is offered for non-Google providers too', async () => {
  await mount(<Form providers={[]} profile={profileWith({}, 'custom')} onSave={() => {}} onCancel={() => {}} />)
  expect(bypassCheckbox()).not.toBeNull()
})

test('every locale labels the toggle', async () => {
  for (const locale of ['de', 'en', 'fr', 'it', 'ja', 'ko', 'zh', 'zh-TW']) {
    const strings = (await import(`@/i18n/locales/${locale}/panels.json`)).default.connectionForm
    expect(strings.bypassStatusCheck, locale).toBeString()
    expect(strings.bypassStatusCheckHint, locale).toBeString()
  }
})
