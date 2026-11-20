import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { UpdateVectorStoreConfigInput, VectorStoreConfigStatus } from '@/api/embeddings'

let config: VectorStoreConfigStatus
const getVectorStoreConfig = mock(async () => config)
const updateVectorStoreConfig = mock(async (input: UpdateVectorStoreConfigInput) => {
  config = {
    ...config,
    tuningProfile: input.tuningProfile,
    milvus: { ...config.milvus!, flushPolicy: input.milvusFlushPolicy ?? config.milvus?.flushPolicy },
    milvusHybridSearch: input.milvusHybridSearch,
  }
  return config
})
const getHealth = mock(async () => ({ provider: 'milvus' }))
mock.module('@/api/embeddings', () => ({ embeddingsApi: { getVectorStoreConfig, updateVectorStoreConfig, getHealth } }))
mock.module('@/api/operator', () => ({
  operatorApi: new Proxy({}, { get: () => async () => { throw new Error('unavailable') } }),
}))
mock.module('@/api/settings', () => ({ settingsApi: {} }))
mock.module('@/api/images', () => ({ imagesApi: {} }))
mock.module('@/lib/settings-tab-registry', () => ({ sectionAnchorId: (...parts: string[]) => parts.join('-') }))
mock.module('@/ws/client', () => ({ wsClient: { on: () => () => {}, connected: true } }))
const t = (key: string) => key
const noop = () => {}
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t }), initReactI18next: { type: '3rdParty', init: noop },
}))
const state = {
  operatorBusy: null,
  operatorProgressMessage: null,
  thumbnailQueue: { remaining: 0, processed: 0, total: 0 },
  operatorLogs: [],
  clearOperatorLogs: noop,
  thumbnailSettings: {},
  setThumbnailQueue: noop,
  setSetting: noop,
  addToast: noop,
}
const useStore = Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state })
mock.module('@/store', () => ({ useStore }))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Reflect.get(globalThis, key)]))
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { default: OperatorPanel } = await import('./OperatorPanel')
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  config = {
    provider: 'milvus', milvus: { address: 'milvus.example:19530', flushPolicy: 'per_write' },
    managedByEnv: false, qdrantHasApiKey: false, milvusHasPassword: true,
  }
  getVectorStoreConfig.mockClear()
  updateVectorStoreConfig.mockClear()
  getHealth.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
afterAll(() => {
  dom.window.close()
  for (const [key, value] of Object.entries(previous)) Reflect.set(globalThis, key, value)
})

async function render() {
  await act(async () => { root.render(<OperatorPanel />) })
}

function field(label: string): HTMLSelectElement {
  const element = Array.from(host.querySelectorAll('label')).find((node) => node.textContent?.includes(label))
  const select = element?.querySelector('select')
  if (!select) throw new Error(`Missing select ${label}`)
  return select
}

function applyButton(): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find((node) => node.textContent?.includes('Apply Runtime Tuning'))
  if (!button) throw new Error('Missing Apply Runtime Tuning')
  return button
}

async function changePolicy(value: string) {
  await act(async () => {
    const select = field('Flush Policy')
    select.value = value
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}

test('applies both flush policies and preserves unrelated connection edits', async () => {
  await render()
  expect(applyButton().disabled).toBe(true)

  await changePolicy('manual')
  expect(applyButton().disabled).toBe(false)
  await changePolicy('per_write')
  expect(applyButton().disabled).toBe(true)
  await changePolicy('manual')

  const address = Array.from(host.querySelectorAll('input')).find((node) => node.placeholder === 'localhost:19530')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(address, 'new.example:19530')
    address.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await act(async () => { applyButton().click() })
  expect(updateVectorStoreConfig).toHaveBeenLastCalledWith({
    tuningProfile: 'balanced', milvusFlushPolicy: 'manual',
    milvusHybridSearch: { candidateMultiplier: 3, candidateCap: 200 },
  })
  expect(field('Flush Policy').value).toBe('manual')
  expect(applyButton().disabled).toBe(true)
  expect(address.value).toBe('new.example:19530')

  const reload = Array.from(host.querySelectorAll('button')).find((node) => node.textContent?.includes('Reload Config'))!
  await act(async () => { reload.click() })
  expect(field('Flush Policy').value).toBe('manual')
  expect(applyButton().disabled).toBe(true)

  await changePolicy('per_write')
  expect(applyButton().disabled).toBe(false)
  await act(async () => { applyButton().click() })
  expect(updateVectorStoreConfig.mock.calls[1]?.[0].milvusFlushPolicy).toBe('per_write')
  expect(applyButton().disabled).toBe(true)
})

test('allows runtime policy changes for an environment-managed connection', async () => {
  config = { ...config, managedByEnv: true, milvus: { ...config.milvus!, flushPolicy: 'manual' } }
  await render()
  expect(field('Flush Policy').disabled).toBe(false)
  await changePolicy('per_write')
  expect(applyButton().disabled).toBe(false)
  await act(async () => { applyButton().click() })
  expect(updateVectorStoreConfig.mock.calls[0]?.[0].milvusFlushPolicy).toBe('per_write')
  expect(applyButton().disabled).toBe(true)
})
