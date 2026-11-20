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
// Folder save/cancel behavior is exercised with real managers in the browser test.
mock.module('@/components/panels/connection-manager/ConnectionFolderField', () => ({
  default: () => null,
  useConnectionFolderDraft: () => ({ value: '', onChange: () => {} }),
}))
mock.module('@/hooks/useConnectionLibrary', () => ({ saveConnectionFolder: () => {} }))
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
const authStarts: any[] = []
const authCompletions: any[] = []
let popupOptions: any
let popupResult: Promise<{ sessionToken: string; code: string } | null> = Promise.resolve(null)
let cancelCalls = 0
let completeImpl = async (): Promise<any> => ({ success: true, created: false, profile: { ...profile, api_url: '', has_api_key: true } })
mock.module('@/lib/providerOAuthPopup', () => ({
  startProviderOAuthPopup: (options: any) => { popupOptions = options; return { result: popupResult, cancel: () => { cancelCalls++ } } },
}))
let previewImpl = async (_input: any): Promise<DecisionConnectionModelsResult> => ({ provider: 'openrouter', models: [] })
mock.module('@/api/decision-connections', () => ({ decisionConnectionsApi: {
  previewModels: async (input: any) => { previews.push(input); return previewImpl(input) },
  initiateAuth: async (...args: any[]) => { authStarts.push(args); return { auth_url: 'https://provider.test/auth', session_token: 'session' } },
  completeAuth: async (...args: any[]) => { authCompletions.push(args); return completeImpl() },
} }))
const providers: DecisionProviderInfo[] = [
  { id: 'openrouter', name: 'OpenRouter', capabilities: { apiKeyRequired: true, defaultUrl: 'https://openrouter.ai/api/v1', suggestedModel: '~typesafe/jev-latest', modelListStyle: 'dynamic' } },
  { id: 'typesafe', name: 'TypeSafe', capabilities: { apiKeyRequired: true, defaultUrl: 'https://api.typesafe.ai/v1', suggestedModel: 'jev-latest', modelListStyle: 'dynamic' } },
  { id: 'nanogpt', name: 'NanoGPT', capabilities: { apiKeyRequired: true, defaultUrl: 'https://nano-gpt.com/api/v1', suggestedModel: 'typesafe/jev-latest', modelListStyle: 'dynamic' } },
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
  authStarts.length = 0
  authCompletions.length = 0
  popupOptions = undefined
  popupResult = Promise.resolve(null)
  cancelCalls = 0
  completeImpl = async () => ({ success: true, created: false, profile: { ...profile, api_url: '', has_api_key: true } })
})
async function render(saved?: DecisionConnectionProfile, onSave: (input: CreateDecisionConnectionInput) => void | Promise<void> = () => {}, onOAuthComplete?: (profile: DecisionConnectionProfile, created: boolean) => void) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<Form providers={providers} profile={saved} onSave={onSave} onCancel={() => {}} onOAuthComplete={onOAuthComplete} />))
}
function signInButton() { return [...container.querySelectorAll('button')].find((b) => b.textContent === 'decisionConnectionForm.signIn') }
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

test.each(['openrouter', 'nanogpt'])('signs in to a new %s decision connection with the selected settings', async (provider) => {
  const completions: any[] = []
  popupResult = Promise.resolve({ sessionToken: 'session', code: 'code' })
  completeImpl = async () => ({ success: true, created: true, profile: { ...profile, id: 'created', provider } })
  await render(undefined, () => {}, (...args) => { completions.push(args) })
  expect(signInButton()?.disabled).toBe(true)
  await act(async () => { providerProps.onChange(provider); fields.get('name').onChange('Decision sign-in') })
  await act(async () => { modelProps.onChange('typesafe/pinned') })
  await act(async () => { signInButton()!.click() })
  expect(popupOptions.provider).toBe(provider)
  expect(new URL(popupOptions.callbackUrl).pathname).toBe(`/api/v1/${provider}/oauth-landing`)
  await popupOptions.initiate()
  expect(authStarts[0]).toEqual([provider, popupOptions.callbackUrl, { connection: {
    name: 'Decision sign-in', provider, model: 'typesafe/pinned', api_url: '', is_default: false,
  } }])
  expect(authCompletions).toEqual([['session', 'code']])
  expect(completions[0][0].id).toBe('created')
  expect(completions[0][1]).toBe(true)
})

test('existing sign-in clears pending key removal, refreshes discovery and preserves other edits', async () => {
  const saves: CreateDecisionConnectionInput[] = []
  const completions: any[] = []
  popupResult = Promise.resolve({ sessionToken: 'session', code: 'code' })
  await render({ ...profile, api_url: '' }, (input) => { saves.push(input) }, (...args) => { completions.push(args) })
  await act(async () => { fields.get('name').onChange('Edited name'); fields.get('key').onChange('manual-replacement') })
  await act(async () => { (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click() })
  await act(async () => { signInButton()!.click() })
  await popupOptions.initiate()
  expect(authStarts[0][2]).toEqual({ connection_id: 'saved' })
  expect(fields.get('key').value).toBe('')
  expect(fields.get('key').placeholder).toBe('••••••••')
  expect(container.querySelector('[role="status"]')?.textContent).toBe('decisionConnectionForm.signInSaved')
  await act(async () => { await modelProps.onRefresh() })
  expect(previews[0].api_key).toBeUndefined()
  await save()
  expect(saves[0]).toMatchObject({ name: 'Edited name', model: profile.model })
  expect(saves[0].api_key).toBeUndefined()
  expect(completions[0][1]).toBe(false)
})

test('hides unsupported provider sign-in and requires saving changed provider or endpoint', async () => {
  await render(profile)
  expect(signInButton()?.disabled).toBe(true)
  await act(async () => { fields.get('url').onChange('') })
  expect(signInButton()?.disabled).toBe(true)
  await act(async () => { providerProps.onChange('typesafe') })
  expect(signInButton()).toBeUndefined()
  await act(async () => { providerProps.onChange('nanogpt') })
  expect(signInButton()?.disabled).toBe(true)
})

test('cancelling sign-in does not exchange a code or save a connection', async () => {
  const saves: any[] = []
  await render({ ...profile, api_url: '' }, (input) => { saves.push(input) })
  await act(async () => { signInButton()!.click() })
  expect(authCompletions).toHaveLength(0)
  expect(saves).toHaveLength(0)
  expect(signInButton()?.disabled).toBe(false)
})

test('failed exchanges show an error and retain the form values for retry', async () => {
  popupResult = Promise.resolve({ sessionToken: 'session', code: 'code' })
  completeImpl = async () => { throw { body: { error: 'Provider unavailable' } } }
  await render({ ...profile, api_url: '' })
  await act(async () => { fields.get('key').onChange('manual-key') })
  await act(async () => { signInButton()!.click() })
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Provider unavailable')
  expect(fields.get('key').value).toBe('manual-key')
  expect(signInButton()?.disabled).toBe(false)
})

test('unmount cancels an outstanding popup and ignores late authorization', async () => {
  let resolve!: (value: { sessionToken: string; code: string }) => void
  popupResult = new Promise((done) => { resolve = done })
  await render({ ...profile, api_url: '' })
  await act(async () => { signInButton()!.click() })
  expect(container.querySelector('fieldset')?.disabled).toBe(true)
  await act(async () => root!.unmount())
  root = undefined
  expect(cancelCalls).toBe(1)
  await act(async () => { resolve({ sessionToken: 'late', code: 'code' }) })
  expect(authCompletions).toHaveLength(0)
})
