import { afterEach, expect, mock, test } from 'bun:test'
import type { StartupSettings } from '@/types/store'
import { bootstrapApi } from '@/api/bootstrap'

const hydrate = mock((settings: StartupSettings) => { state.settingsLoaded = true; state.settings = settings })
const loadSettings = mock(async () => { state.settingsLoaded = true; state.fullSettingsLoaded = true })
const state = { settingsLoaded: false, fullSettingsLoaded: false, settings: {} as StartupSettings, hydrateStartupSettings: hydrate, loadSettings }
mock.module('@/store', () => ({ useStore: Object.assign(() => {}, { getState: () => state }) }))
const { loadStartupSettings } = await import('./useAppInit')
const original = bootstrapApi.fetchStartup
afterEach(() => {
  bootstrapApi.fetchStartup = original
  state.settingsLoaded = false
  state.fullSettingsLoaded = false
  state.settings = {}
  hydrate.mockClear()
  loadSettings.mockClear()
})

test('hydrates all styling without waiting for the full bootstrap or settings', async () => {
  const settings: StartupSettings = {
    customCSS: { css: 'body { color: red }', enabled: true, revision: 2, bundleId: 'a' },
    componentOverrides: { InputArea: { css: 'input { padding: 20px }', tsx: '', enabled: true } },
  }
  bootstrapApi.fetchStartup = async () => settings
  await loadStartupSettings(() => true)
  expect(hydrate).toHaveBeenCalledWith(settings)
  expect(state.settingsLoaded).toBe(true)
})

test('discards an in-flight snapshot after the authenticated account changes', async () => {
  let complete!: (settings: StartupSettings) => void
  bootstrapApi.fetchStartup = () => new Promise(resolve => { complete = resolve })
  let current = true
  const loading = loadStartupSettings(() => current)
  current = false
  complete({ customCSS: { css: 'body { color: red }', enabled: true, revision: 1, bundleId: 'old' } })
  await loading
  expect(hydrate).not.toHaveBeenCalled()
})

test('does not overwrite a snapshot already hydrated by another startup path', async () => {
  let complete!: (settings: StartupSettings) => void
  bootstrapApi.fetchStartup = () => new Promise(resolve => { complete = resolve })
  const loading = loadStartupSettings(() => true)
  state.settingsLoaded = true
  complete({})
  await loading
  expect(hydrate).not.toHaveBeenCalled()
})

test('startup endpoint failures immediately try full settings without waiting for bootstrap', async () => {
  bootstrapApi.fetchStartup = async () => { throw new Error('older server') }
  await loadStartupSettings(() => true)
  expect(hydrate).not.toHaveBeenCalled()
  expect(loadSettings).toHaveBeenCalledTimes(1)
  expect(state.settingsLoaded).toBe(true)
})
