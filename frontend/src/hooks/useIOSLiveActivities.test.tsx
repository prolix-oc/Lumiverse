import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.example' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
const nativeCalls: { action: string; payload: any }[] = []
const apiCalls: { path: string; payload: any }[] = []
let appState = 'active', enabled = true
let failSpindle = false
let native: { available: boolean; generationIds: string[]; suppressedGenerationIds: string[]; deviceId: string; bundleId: string; environment: string; spindleAvailable?: boolean; spindleRegistrationIds?: string[] } = { available: true, generationIds: [] as string[], suppressedGenerationIds: [] as string[], deviceId: 'installation-123456789', bundleId: 'chat.lumiverse.ios', environment: 'development' }
let snapshot = { active: [] as { generationId: string }[], existing: [] as { generationId: string; state: { phase: string; label: string } }[] }
let prepare: (() => Promise<Record<string, unknown>>) | undefined
let configure: (() => Promise<unknown>) | undefined
const stateListeners = new Set<(state: string) => void>()
mock.module('@/api/client', () => ({
  get: async () => ({ configured: true, bundleId: native.bundleId }),
  post: async (path: string, payload: any) => {
    apiCalls.push({ path, payload })
    if (path.includes('/spindle-activities/')) { if (failSpindle) throw new Error('Enrollment pending'); return { items: [{ registrationId: 'extension-task' }] } }
    if (path.endsWith('/snapshot')) return snapshot
    return prepare ? prepare() : { registrationId: 'new-registration', ...payload }
  },
}))
mock.module('@/lib/ios-native', () => ({
  hasIOSNativeBridge: () => true,
  iosNativeRequest: async (action: string, payload: any) => {
    nativeCalls.push({ action, payload })
    if (action === 'activities.configure' && configure) return configure()
    return { started: true }
  },
}))
mock.module('@/lib/ios-live-activities', () => ({ useIOSLiveActivitiesEnabled: () => enabled, getIOSActivityStatus: async () => native }))
mock.module('@/lib/ios-app-state', () => ({
  getIOSAppState: () => appState,
  subscribeIOSAppState: (listener: (state: string) => void) => { stateListeners.add(listener); return () => stateListeners.delete(listener) },
}))
mock.module('@/store', () => ({ useStore: { subscribe: () => () => {} } }))
let root: Root
let hook: typeof import('./useIOSLiveActivities').useIOSLiveActivities
beforeAll(async () => { hook = (await import('./useIOSLiveActivities')).useIOSLiveActivities })
beforeEach(async () => {
  appState = 'active'; enabled = true; prepare = undefined; configure = undefined; failSpindle = false
  native = { ...native, available: true, generationIds: [], suppressedGenerationIds: [], spindleAvailable: undefined, spindleRegistrationIds: undefined }
  snapshot = { active: [], existing: [] }
  nativeCalls.length = 0; apiCalls.length = 0
  const container = document.createElement('div'); document.body.append(container)
  root = (await import('react-dom/client')).createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren() })
afterAll(() => { mock.restore(); dom.window.close() })
function Probe({ account }: { account: string | null | undefined }) { hook(account); return null }
async function render(account: string | null | undefined) { await act(async () => { root.render(<Probe account={account} />) }) }
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) }) }

test('authentication recovery waits for resolution and authoritative empty snapshots start nothing', async () => {
  await render(undefined)
  await settle()
  expect(nativeCalls).toHaveLength(0)
  await render('owner')
  await settle()
  expect(nativeCalls[0]).toEqual({ action: 'activities.configure', payload: { accountId: 'owner', enabled: true } })
  expect(apiCalls).toHaveLength(1)
  expect(apiCalls[0]?.path).toEndWith('/snapshot')
  expect(nativeCalls.some(call => call.action === 'activities.start')).toBe(false)
})

test('authoritative active generations start once while dismissed and existing activities stay suppressed', async () => {
  native.generationIds = ['existing']; native.suppressedGenerationIds = ['dismissed']
  snapshot = { active: [{ generationId: 'new' }, { generationId: 'existing' }, { generationId: 'dismissed' }],
    existing: [{ generationId: 'existing', state: { phase: 'completed', label: 'Response ready' } }] }
  await render('owner'); await settle()
  expect(apiCalls.filter(call => call.path.endsWith('/prepare')).map(call => call.payload.generationId)).toEqual(['new'])
  expect(nativeCalls.filter(call => call.action === 'activities.start')).toHaveLength(1)
  expect(nativeCalls.find(call => call.action === 'activities.reconcile')?.payload.snapshots).toEqual(snapshot.existing)
})

test('background snapshots cannot start activities; logout and disabled preferences still clean up', async () => {
  appState = 'background'
  snapshot.active = [{ generationId: 'new' }]
  await render('owner'); await settle()
  expect(apiCalls).toHaveLength(0)
  await render(null); await settle()
  expect(nativeCalls.at(-1)).toEqual({ action: 'activities.configure', payload: { accountId: null, enabled: false } })
  enabled = false
  await render('owner'); await settle()
  expect(nativeCalls.at(-1)?.payload.enabled).toBe(false)
  expect(apiCalls).toHaveLength(0)
})

test('an enrollment finishing after account change cannot start the previous account activity', async () => {
  snapshot.active = [{ generationId: 'old' }]
  let release!: (value: Record<string, unknown>) => void
  prepare = () => new Promise(resolve => { release = resolve })
  await render('owner'); await settle()
  expect(apiCalls.some(call => call.path.endsWith('/prepare'))).toBe(true)
  await render(null)
  release({ registrationId: 'old-registration' })
  await settle()
  expect(nativeCalls.some(call => call.action === 'activities.start')).toBe(false)
})

test('a failed initial configure recovers on network return without remounting', async () => {
  snapshot.active = [{ generationId: 'recover' }]
  configure = async () => { throw new Error('Lost WebKit reply') }
  await render('owner'); await settle()
  expect(apiCalls).toHaveLength(0)
  configure = undefined
  window.dispatchEvent(new dom.window.Event('online'))
  await settle()
  expect(nativeCalls.filter(call => call.action === 'activities.start')).toHaveLength(1)
})

test('foreground recovery replaces a suspended prepare and ignores its late enrollment', async () => {
  snapshot.active = [{ generationId: 'recover' }]
  let release!: (value: Record<string, unknown>) => void
  prepare = () => new Promise(resolve => { release = resolve })
  await render('owner'); await settle()
  appState = 'background'; stateListeners.forEach(listener => listener(appState))
  prepare = undefined
  appState = 'active'; stateListeners.forEach(listener => listener(appState))
  await settle()
  expect(nativeCalls.filter(call => call.action === 'activities.start')).toHaveLength(1)
  release({ registrationId: 'stale-registration' }); await settle()
  expect(nativeCalls.filter(call => call.action === 'activities.start')).toHaveLength(1)
})


test('template-capable apps enroll extension activities without requiring a chat generation', async () => {
  native.spindleAvailable = true; native.spindleRegistrationIds = ['known-registration']
  await render('owner'); await settle()
  expect(apiCalls.find(call => call.path.includes('/spindle-activities/'))?.payload).toMatchObject({ registrationIds: ['known-registration'], serverOrigin: 'https://lumiverse.example' })
  expect(nativeCalls.find(call => call.action === 'activities.spindleSync')?.payload).toEqual({ items: [{ registrationId: 'extension-task' }] })
  expect(nativeCalls.some(call => call.action === 'activities.start')).toBe(false)
})

test('an extension enrollment failure does not block generation activity recovery', async () => {
  native.spindleAvailable = true; failSpindle = true; snapshot.active = [{ generationId: 'generation' }]
  await render('owner'); await settle()
  expect(nativeCalls.some(call => call.action === 'activities.spindleSync')).toBe(false)
  expect(nativeCalls.some(call => call.action === 'activities.start')).toBe(true)
})

test('native authorization denial revokes template delivery even when all activities are unavailable', async () => {
  native.available = false; native.spindleAvailable = false
  await render('owner'); await settle()
  expect(apiCalls.map(call => call.path)).toEqual(['/push/ios/spindle-activities/disable'])
})
