import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { CreateImageGenConnectionInput, ImageGenConnectionProfile, ImageGenProviderInfo } from '@/types/api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
})

const t = (key: string) => key
// Folder save/cancel behavior is exercised with real managers in the browser test.
mock.module('@/components/panels/connection-manager/ConnectionFolderField', () => ({
  default: () => null,
  useConnectionFolderDraft: () => ({ value: '', onChange: () => {} }),
}))
mock.module('@/hooks/useConnectionLibrary', () => ({ saveConnectionFolder: () => {} }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t }) }))
mock.module('../connection-manager/ModelCombobox', () => ({ default: () => null }))

let Form: typeof import('./ImageGenConnectionForm').default
let createRoot: typeof CreateRoot
let root: Root | undefined
let container: HTMLDivElement
let saved: CreateImageGenConnectionInput[]
const providers: ImageGenProviderInfo[] = ['novelai', 'google_gemini'].map((id) => ({
  id, name: id,
  capabilities: { parameters: {}, apiKeyRequired: true, modelListStyle: 'static', defaultUrl: 'https://image.novelai.net' },
}))

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  Form = (await import('./ImageGenConnectionForm')).default
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  container?.remove()
})

function profile(overrides: Partial<ImageGenConnectionProfile> = {}): ImageGenConnectionProfile {
  return {
    id: 'nai', name: 'NovelAI', provider: 'novelai', api_url: 'https://proxy.example/root/',
    model: 'nai-diffusion-5-full', is_default: false, has_api_key: true,
    default_parameters: { steps: 28 }, metadata: {}, created_at: 1, updated_at: 1,
    ...overrides,
  }
}

async function render(connection?: ImageGenConnectionProfile) {
  saved = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<Form providers={providers} profile={connection} onSave={(input) => saved.push(input)} onCancel={() => {}} />)
  })
}

function checkbox(): HTMLInputElement | null {
  const label = [...container.querySelectorAll('label')].find((el) => el.textContent?.includes('imageGenConnectionForm.novelaiNonStreaming'))
  return label?.querySelector('input') ?? null
}

async function save() {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent === 'connectionForm.save')!
  await act(async () => button.click())
}

test('new and existing NovelAI profiles default to streaming', async () => {
  await render()
  expect(checkbox()?.checked).toBe(false)
  await act(async () => root!.render(<Form key="existing" providers={providers} profile={profile()} onSave={(input) => saved.push(input)} onCancel={() => {}} />))
  expect(checkbox()?.checked).toBe(false)
  await save()
  expect(saved[0].metadata?.novelai?.nonStreaming).toBe(false)
})

test('enabling non-streaming preserves the base URL and unrelated metadata', async () => {
  const connection = profile({ metadata: { label: 'keep', novelai: { futureOption: 7 } } })
  await render(connection)
  await act(async () => checkbox()!.click())
  await save()
  expect(saved[0].api_url).toBe(connection.api_url)
  expect(saved[0].metadata).toEqual({ label: 'keep', novelai: { futureOption: 7, nonStreaming: true } })
  expect(connection.metadata).toEqual({ label: 'keep', novelai: { futureOption: 7 } })
  expect(saved[0].default_parameters).toBeUndefined()
})

test('a saved non-streaming profile reopens checked and can return to streaming', async () => {
  await render(profile({ metadata: { novelai: { nonStreaming: true } } }))
  expect(checkbox()?.checked).toBe(true)
  await act(async () => checkbox()!.click())
  await save()
  expect(saved[0].metadata?.novelai?.nonStreaming).toBe(false)
  expect(saved[0].api_url).toBe('https://proxy.example/root/')
})

test('clearing the API URL sends an explicit empty value', async () => {
  await render(profile())
  const input = container.querySelector<HTMLInputElement>('input[placeholder="https://image.novelai.net"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await save()
  expect(JSON.parse(JSON.stringify(saved[0])).api_url).toBe('')
})

test('other providers do not expose or save the NovelAI checkbox', async () => {
  await render(profile({ provider: 'google_gemini' }))
  expect(checkbox()).toBeNull()
  await save()
  expect(saved[0].metadata).toBeUndefined()
})
