import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { DecisionConnectionProfile, DecisionProviderInfo, DecisionConnectionModelsResult, CreateDecisionConnectionInput } from '@/types/api'

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
mock.module('react-i18next', () => ({ useTranslation: () => ({ t }) }))
const fields = new Map<string, any>()
let modelProps: any
let providerProps: any
mock.module('@/components/shared/FormComponents', () => ({
  FormField: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextInput: (props: any) => { fields.set(props.type === 'password' ? 'key' : props.placeholder === 'decisionConnectionForm.connectionName' ? 'name' : 'url', props); return <input readOnly value={props.value} type={props.type || 'text'} /> },
  Select: (props: any) => { providerProps = props; return null },
  Button: ({ children, ...props }: any) => <button disabled={props.disabled} onClick={props.onClick}>{children}</button>,
}))
mock.module('../connection-manager/ModelCombobox', () => ({
  default: (props: any) => { modelProps = props; return null },
}))
const previews: any[] = []
let previewImpl = async (_input: any): Promise<DecisionConnectionModelsResult> => ({ provider: 'openrouter', models: [] })
mock.module('@/api/decision-connections', () => ({ decisionConnectionsApi: {
  previewModels: async (input: any) => { previews.push(input); return previewImpl(input) },
} }))
const providers: DecisionProviderInfo[] = [
  { id: 'openrouter', name: 'OpenRouter', capabilities: { apiKeyRequired: true, defaultUrl: 'https://openrouter.ai/api/v1', suggestedModel: '~typesafe/jev-latest', modelListStyle: 'dynamic' } },
  { id: 'typesafe', name: 'TypeSafe', capabilities: { apiKeyRequired: true, defaultUrl: 'https://api.typesafe.ai/v1', suggestedModel: 'jev-latest', modelListStyle: 'dynamic' } },
]
const profile: DecisionConnectionProfile = {
  id: 'saved', name: 'Pinned', provider: 'openrouter', api_url: 'https://proxy.test/v1', model: '~typesafe/pinned',
  has_api_key: true, is_default: true, default_parameters: {}, metadata: {}, created_at: 0, updated_at: 0,
}
let Form: typeof import('./DecisionConnectionForm').default
let createRoot: typeof CreateRoot
let root: Root | undefined
let container: HTMLDivElement
beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  Form = (await import('./DecisionConnectionForm')).default
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  container?.remove()
  previews.length = 0
  fields.clear()
  previewImpl = async () => ({ provider: 'openrouter', models: [] })
})
async function render(saved?: DecisionConnectionProfile, onSave: (input: CreateDecisionConnectionInput) => void | Promise<void> = () => {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<Form providers={providers} profile={saved} onSave={onSave} onCancel={() => {}} />))
}
async function save() {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'decisionConnectionForm.save' || b.textContent === 'decisionConnectionForm.create')!
  await act(async () => { button.click() })
}
test('keeps a pinned model when discovery does not contain it', async () => {
  const saves: CreateDecisionConnectionInput[] = []
  await render(profile, (input) => { saves.push(input) })
  await act(async () => { await modelProps.onRefresh() })
  expect(modelProps.value).toBe('~typesafe/pinned')
  expect(modelProps.models).toContain('~typesafe/pinned')
  expect(previews[0]).toEqual({ connection_id: 'saved', provider: 'openrouter', api_url: 'https://proxy.test/v1', api_key: undefined })
  await save()
  expect(saves[0]?.model).toBe('~typesafe/pinned')
  expect(saves[0]?.api_key).toBeUndefined()
})
test('provider changes reset the endpoint, credentials and suggested model', async () => {
  await render(profile)
  await act(async () => { fields.get('key').onChange('replacement') })
  await act(async () => { providerProps.onChange('typesafe') })
  expect(fields.get('url').value).toBe('')
  expect(fields.get('key').value).toBe('')
  expect(fields.get('key').placeholder).toBe('decisionConnectionForm.enterApiKey')
  expect(modelProps.value).toBe('jev-latest')
  await act(async () => { await modelProps.onRefresh() })
  expect(previews[0]).toMatchObject({ provider: 'typesafe', api_url: '', api_key: undefined })
})
test('clearing a custom URL and saved key sends explicit empty values', async () => {
  const saves: CreateDecisionConnectionInput[] = []
  await render(profile, (input) => { saves.push(input) })
  await act(async () => { fields.get('url').onChange('') })
  const remove = container.querySelector('input[type="checkbox"]') as HTMLInputElement
  await act(async () => { remove.click() })
  await act(async () => { await modelProps.onRefresh() })
  expect(previews[0].api_key).toBe('')
  await save()
  expect(saves[0]).toMatchObject({ api_url: '', api_key: '' })
})
test('stale model requests cannot replace models for the new provider', async () => {
  let resolve!: (result: DecisionConnectionModelsResult) => void
  previewImpl = () => new Promise((done) => { resolve = done })
  await render(profile)
  let pending!: Promise<void>
  await act(async () => { pending = modelProps.onRefresh() })
  await act(async () => { providerProps.onChange('typesafe') })
  await act(async () => { resolve({ provider: 'openrouter', models: [{ id: 'old/model', label: 'Old', protocol: 'supported' }] }); await pending })
  expect(modelProps.value).toBe('jev-latest')
  expect(modelProps.models).not.toContain('old/model')
  expect(modelProps.loading).toBe(false)
})
test('shows save errors and retains the editable profile', async () => {
  await render(profile, async () => { throw { body: { error: 'Cannot save connection' } } })
  await save()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Cannot save connection')
  expect(modelProps.value).toBe(profile.model)
})
test('incompatible catalog models cannot be saved', async () => {
  previewImpl = async () => ({ provider: 'openrouter', models: [{ id: 'togethercomputer/tev1-4b-experimental', label: 'Tev1', protocol: 'unsupported' }] })
  const saves: CreateDecisionConnectionInput[] = []
  await render(profile, (input) => { saves.push(input) })
  await act(async () => { await modelProps.onRefresh() })
  expect(modelProps.models).not.toContain('togethercomputer/tev1-4b-experimental')
  await act(async () => { modelProps.onChange('togethercomputer/tev1-4b-experimental') })
  await save()
  expect(saves).toHaveLength(0)
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('decisionConnectionForm.unsupportedModel')
})
