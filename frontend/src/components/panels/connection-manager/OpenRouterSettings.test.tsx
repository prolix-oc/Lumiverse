import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, useEffect, useState, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import panels from '@/i18n/locales/en/panels.json'
import type { OpenRouterConnectionSettings, OpenRouterProviderEntry } from '@/api/openrouter'
import type { ConnectionProfile, CreateConnectionProfileInput } from '@/types/api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, sessionStorage: dom.window.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })

const endpointCalls: { connectionId: string; model: string }[] = []
let discover: (model: string) => Promise<{ endpoints: OpenRouterProviderEntry[] }>
mock.module('@/api/openrouter', () => ({
  buildOpenRouterOAuthCallbackUrl: () => 'http://localhost/callback',
  openrouterApi: {
    credits: async () => null,
    completeAuth: async () => ({ created: true, profile: oauthProfile }),
    providers: async () => ({ providers: [{ name: 'OpenAI', slug: 'openai' }, { name: 'Azure', slug: 'azure' }] }),
    endpoints: async (connectionId: string, model: string) => {
      endpointCalls.push({ connectionId, model })
      return discover(model)
    },
  },
}))
mock.module('@/api/connections', () => ({ connectionsApi: { previewModels: async () => ({ models: ['openai/gpt-5.4'] }) } }))
const oauthProfile: ConnectionProfile = {
  id: 'oauth-created', name: 'OAuth connection', provider: 'openrouter', api_url: '', model: '',
  has_api_key: true, is_default: false, preset_id: null, metadata: {}, created_at: 0, updated_at: 0,
}
mock.module('@/lib/providerOAuthPopup', () => ({
  startProviderOAuthPopup: () => ({ result: Promise.resolve({ sessionToken: 'session', code: 'code' }), cancel: () => {} }),
}))
const store = {
  profiles: [] as ConnectionProfile[], reasoningSettings: {}, promptBias: '', fullSettingsLoaded: true,
  connectionLibraries: { llm: { folders: [{ id: 'cloud', name: 'Cloud' }], folderOrder: ['cloud', ''], assignments: {} as Record<string, string> } },
  setSetting: (_key: string, value: typeof store.connectionLibraries) => { store.connectionLibraries = value },
}
const useStore = Object.assign((selector: (value: typeof store) => unknown) => selector(store), { getState: () => store })
mock.module('@/store', () => ({ useStore }))

const endpoints = [
  { name: 'OpenAI', slug: 'openai' },
  { name: 'OpenAI', slug: 'openai/flex' },
  { name: 'Azure', slug: 'azure/eu' },
]
let createRoot: typeof CreateRoot
let Settings: typeof import('./OpenRouterSettings').default
let Form: typeof import('./ConnectionForm').default
let root: Root | undefined
let host: HTMLDivElement
let latest: OpenRouterConnectionSettings
let switchModel: (model: string) => void
const i18n = createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { panels } }, interpolation: { escapeValue: false } })
  createRoot = (await import('react-dom/client')).createRoot
  Settings = (await import('./OpenRouterSettings')).default
  Form = (await import('./ConnectionForm')).default
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  endpointCalls.length = 0
  discover = async () => ({ endpoints })
})

async function mount(element: ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>) })
}
async function render(initial: OpenRouterConnectionSettings = {}, connectionId: string | null = 'saved') {
  latest = initial
  discover ||= async () => ({ endpoints })
  function Harness() {
    const [settings, setSettings] = useState(initial)
    const [model, setModel] = useState('openai/gpt-5.4')
    useEffect(() => { switchModel = setModel }, [setModel])
    return <Settings settings={settings} onChange={(next) => { latest = next; setSettings(next) }} model={model} connectionId={connectionId || undefined} hasApiKey />
  }
  await mount(<Harness />)
}
async function expand() { await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click()) }
async function settle() { await act(async () => { await Bun.sleep(300) }) }
function field(label: string) {
  return [...host.querySelectorAll('label')].find((element) => element.textContent === label)!.parentElement!
}
async function choose(label: string, provider: string) {
  const container = field(label)
  await act(async () => container.querySelector('input')!.focus())
  const option = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(provider))!
  await act(async () => option.click())
}

test('discovers exact Flex and region options and restricts routing without changing other settings', async () => {
  await render({ provider_routing: { sort: 'price', allow_fallbacks: true }, plugins: [{ id: 'web', enabled: true }] })
  expect(endpointCalls).toHaveLength(0)
  await expand()
  await settle()
  expect(endpointCalls).toEqual([{ connectionId: 'saved', model: 'openai/gpt-5.4' }])
  await choose('Only These Providers', 'OpenAI — Flex')
  expect(latest).toEqual({ provider_routing: { sort: 'price', allow_fallbacks: true, only: ['openai/flex'] }, plugins: [{ id: 'web', enabled: true }] })
  await choose('Preferred Providers', 'Azure — eu')
  expect(latest.provider_routing?.order).toEqual(['azure/eu'])
  await act(async () => field('Only These Providers').querySelector('button')!.click())
  expect(latest.provider_routing?.only).toBeUndefined()
});

test('late discovery responses cannot populate options for another model', async () => {
  let finishOld!: (result: { endpoints: OpenRouterProviderEntry[] }) => void
  discover = (model) => model === 'openai/gpt-5.4'
    ? new Promise((resolve) => { finishOld = resolve })
    : Promise.resolve({ endpoints: [{ name: 'Google', slug: 'google-vertex/flex' }] })
  await render({ provider_routing: { only: ['openai/flex'] } })
  await expand()
  await settle()
  await act(async () => switchModel('google/gemini-model'))
  await settle()
  await act(async () => finishOld({ endpoints }))
  await act(async () => field('Preferred Providers').querySelector('input')!.focus())
  expect(field('Preferred Providers').textContent).toContain('Google — Flex')
  expect(field('Preferred Providers').textContent).not.toContain('OpenAI — Flex')
  expect(latest.provider_routing?.only).toEqual(['openai/flex'])
});

test('discovery errors preserve saved restrictions and can be retried', async () => {
  discover = async () => { throw new Error('Unavailable') }
  await render({ provider_routing: { only: ['openai/flex'] } })
  await expand()
  await settle()
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Unable to load model endpoints')
  expect(latest.provider_routing?.only).toEqual(['openai/flex'])
  discover = async () => ({ endpoints })
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry loading endpoints')!.click())
  await settle()
  expect(host.querySelector('[role=alert]')).toBeNull()
  await choose('Preferred Providers', 'OpenAI — Flex')
  expect(latest.provider_routing?.order).toEqual(['openai/flex'])
});

test('unsaved connections explain how to load endpoint choices', async () => {
  await render({}, null)
  await expand()
  await settle()
  expect(endpointCalls).toHaveLength(0)
  expect(host.textContent).toContain('Save this connection with an API key')
});

test('Flex-only settings are saved by the connection form and restored when reopened', async () => {
  discover = async () => ({ endpoints })
  const profile: ConnectionProfile = {
    id: 'saved', name: 'Flex connection', provider: 'openrouter', api_url: '', model: 'openai/gpt-5.4',
    has_api_key: true, is_default: false, preset_id: null, metadata: {}, created_at: 0, updated_at: 0,
  }
  const saves: CreateConnectionProfileInput[] = []
  await mount(<Form providers={[]} profile={profile} onSave={(value) => saves.push(value)} onCancel={() => {}} />)
  await expand()
  await settle()
  await choose('Only These Providers', 'OpenAI — Flex')
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === panels.connectionForm.save)!.click())
  expect(saves[0]?.metadata?.openrouter).toEqual({ provider_routing: { only: ['openai/flex'] } })
  await act(async () => root!.unmount())
  host.remove()
  root = undefined
  await render(saves[0].metadata?.openrouter)
  await expand()
  await settle()
  expect(field('Only These Providers').textContent).toContain('OpenAI — Flex')
});


test('OpenRouter sign-in keeps the selected folder for the created connection', async () => {
  const created: ConnectionProfile[] = []
  await mount(<Form providers={[]} initialProvider="openrouter" onSave={() => {}} onCancel={() => {}} onOAuthCreated={profile => created.push(profile)} />)
  const input = host.querySelector<HTMLInputElement>(`input[placeholder="${panels.connectionForm.connectionName}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'OAuth connection')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  const folder = field(panels.connections.folder)
  await act(async () => folder.querySelector<HTMLButtonElement>('button')!.click())
  await act(async () => [...folder.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cloud')!.click())
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === panels.openRouterSettings.signIn)!.click())
  expect(created.map(profile => profile.id)).toEqual(['oauth-created'])
  expect(store.connectionLibraries.llm.assignments['oauth-created']).toBe('cloud')
})
