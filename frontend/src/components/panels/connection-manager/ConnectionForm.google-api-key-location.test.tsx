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

const previewCalls: { provider: string; metadata?: Record<string, unknown> }[] = []
mock.module('@/api/connections', () => ({
  connectionsApi: {
    previewModels: async (input: { provider: string; metadata?: Record<string, unknown> }) => {
      previewCalls.push(input)
      return { models: ['gemini-2.5-flash'] }
    },
  },
}))
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
  previewCalls.length = 0
})

async function mount(element: ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>) })
}
function profileWith(metadata: Record<string, unknown>, provider = 'google'): ConnectionProfile {
  return {
    id: 'gateway', name: 'Gateway', provider, api_url: 'https://gateway.example.test', model: 'gemini-2.5-flash',
    has_api_key: true, is_default: false, preset_id: null, metadata, created_at: 0, updated_at: 0,
  }
}
function locationSelect(): HTMLSelectElement | null {
  return [...host.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'bearer')) ?? null
}
async function chooseLocation(value: string) {
  const select = locationSelect()!
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')!.set!
  await act(async () => {
    setter.call(select, value)
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}
async function save() {
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === panels.connectionForm.save)!.click())
}

test('choosing Bearer saves google_api_key_location and keeps other metadata', async () => {
  const saves: CreateConnectionProfileInput[] = []
  await mount(<Form providers={[]} profile={profileWith({ custom_flag: 'kept' })} onSave={(value) => saves.push(value)} onCancel={() => {}} />)
  expect(locationSelect()?.value).toBe('query')
  await chooseLocation('bearer')
  await save()
  expect(saves[0]?.metadata).toEqual({ custom_flag: 'kept', google_api_key_location: 'bearer' })
})

test('a saved location loads selected and switching back to query removes the key', async () => {
  const saves: CreateConnectionProfileInput[] = []
  await mount(<Form providers={[]} profile={profileWith({ google_api_key_location: 'header' })} onSave={(value) => saves.push(value)} onCancel={() => {}} />)
  expect(locationSelect()?.value).toBe('header')
  await chooseLocation('query')
  await save()
  expect(saves[0]?.metadata).not.toHaveProperty('google_api_key_location')
})

test('model refresh sends the selected location with the preview request', async () => {
  await mount(<Form providers={[]} profile={profileWith({ google_api_key_location: 'bearer' })} onSave={() => {}} onCancel={() => {}} />)
  expect(previewCalls.at(-1)?.metadata?.google_api_key_location).toBe('bearer')
})

test('the setting is only offered for Google Gemini connections', async () => {
  await mount(<Form providers={[]} profile={profileWith({ google_api_key_location: 'bearer' }, 'custom')} onSave={() => {}} onCancel={() => {}} />)
  expect(locationSelect()).toBeNull()
})

test('every locale labels the setting', async () => {
  for (const locale of ['de', 'en', 'fr', 'it', 'ja', 'ko', 'zh', 'zh-TW']) {
    const strings = (await import(`@/i18n/locales/${locale}/panels.json`)).default.connectionForm
    expect(strings.googleApiKeyLocation, locale).toBeString()
    expect(strings.googleApiKeyLocationHint, locale).toBeString()
  }
})
