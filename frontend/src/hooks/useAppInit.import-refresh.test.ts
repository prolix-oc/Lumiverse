import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { subscribeImportedDataRefresh } from '@/lib/import-data-events'

const flush = mock(async () => {})
const reload = mock(() => {})
mock.module('@/lib/import-data-reload', () => ({ reloadImportedData: reload, takeImportReloadReceipt: () => null }))
const fetchBootstrap = mock()
const fetchLanding = mock()
const listLoadouts = mock(async () => [{ id: 'restored-loadout' }])
const loadSettings = mock(async () => { state.fullSettingsLoaded = true })
const page = (data: unknown[] = []) => ({ data, total: data.length, limit: 200, offset: 0 })
let state: any
const api = { getState: () => state, setState: (patch: any) => Object.assign(state, patch) }

mock.module('@/store', () => ({ useStore: Object.assign(() => {}, api) }))
mock.module('@/store/slices/settings', () => ({ flushSettingsNow: flush, setSettingsPersistenceScope() {}, resetSettingsPersistence() {} }))
mock.module('@/api/bootstrap', () => ({ bootstrapApi: { fetch: fetchBootstrap, fetchLanding } }))
mock.module('@/api/loadouts', () => ({ loadoutsApi: { list: listLoadouts } }))
mock.module('@/lib/active-tab', () => ({ activeTab: { signal: new AbortController().signal } }))

const { refreshAppDataAfterImport } = await import('./useAppInit')
let unsubscribe: (() => void) | undefined

beforeEach(() => {
  state = {
    user: { id: 'owner' }, isAuthenticated: true, settingsLoaded: true, fullSettingsLoaded: true,
    charactersLoaded: true, packsWithItems: { old: {} }, loomRegistry: { old: {} },
    landingRecentChats: page(), councilSettings: { members: [] }, imageGenProfilesVersion: 0,
    loadSettings,
    setProfiles: (data: unknown) => { state.profiles = data }, setProviders() {},
    setDecisionProfiles: (data: unknown) => { state.decisionProfiles = data }, setDecisionProviders() {},
    setSttProfiles: (data: unknown) => { state.sttProfiles = data }, setSttProviders() {},
    setTtsProfiles: (data: unknown) => { state.ttsProfiles = data }, setTtsProviders() {},
    setImageGenProfiles: (data: unknown) => { state.imageGenProfiles = data }, setImageGenProviders() {},
    setPacks: (data: unknown) => { state.packs = data }, setPersonas: (data: unknown) => { state.personas = data },
    setRegexScripts: (data: unknown) => { state.regexScripts = data },
    setLandingRecentChats: (data: unknown) => { state.landingRecentChats = data },
    setCouncilSettings: (data: unknown) => { state.councilSettings = data }, setCouncilPersistenceTarget() {},
    hydrateCouncilTools() {},
  }
  flush.mockReset().mockResolvedValue(undefined)
  reload.mockReset()
  loadSettings.mockClear()
  fetchBootstrap.mockReset().mockResolvedValue({ payload: {
    startupSettings: {}, llm: { connections: page([{ id: 'restored-connection' }]), providers: [] },
    decision: { connections: page([{ id: 'restored-decision' }]), providers: [] },
    stt: { connections: page([{ id: 'restored-stt' }]), providers: [] },
    tts: { connections: page([{ id: 'restored-tts' }]), providers: [] },
    imageGen: { connections: page([{ id: 'restored-imagegen' }]), providers: [] },
    packs: page([{ id: 'restored-pack' }]), personas: page([{ id: 'restored-persona' }]),
    regexScripts: page([{ id: 'restored-regex' }]),
    council: { settings: { members: [], toolsSettings: {} }, tools: [] },
    spindle: { extensions: [], tools: [] },
  }, errors: {} })
  fetchLanding.mockReset().mockResolvedValue({ payload: { startupSettings: {}, recentChats: page([{ id: 'restored-chat' }]) }, errors: {} })
})
afterEach(() => unsubscribe?.())

test('restarts every data view once after pending settings commit for duplicate completion signals', async () => {
  const refreshed = mock(() => {})
  unsubscribe = subscribeImportedDataRefresh(refreshed)
  let finishFlush!: () => void
  flush.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFlush = resolve }))
  const jobId = crypto.randomUUID()
  const first = refreshAppDataAfterImport(jobId)
  expect(refreshAppDataAfterImport(jobId)).toBe(first)
  expect(fetchBootstrap).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
  finishFlush()
  await first
  expect(reload).toHaveBeenCalledTimes(1)
  expect(fetchBootstrap).not.toHaveBeenCalled()
  expect(refreshed).not.toHaveBeenCalled()
})

test('discarding an old-user response cannot hydrate the next signed-in account', async () => {
  let finish!: (value: any) => void
  flush.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const refreshed = mock(() => {})
  unsubscribe = subscribeImportedDataRefresh(refreshed)
  const refresh = refreshAppDataAfterImport(crypto.randomUUID())
  await Bun.sleep(0)
  state.user = { id: 'other-owner' }
  finish(undefined)
  await refresh
  expect(state.profiles).toBeUndefined()
  expect(refreshed).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
})

test('a failed settings flush can be retried for the same completed job', async () => {
  flush.mockRejectedValueOnce(new Error('offline'))
  const jobId = crypto.randomUUID()
  await expect(refreshAppDataAfterImport(jobId)).rejects.toThrow('offline')
  await refreshAppDataAfterImport(jobId)
  expect(reload).toHaveBeenCalledTimes(1)
})
