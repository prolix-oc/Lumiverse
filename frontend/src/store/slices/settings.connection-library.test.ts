import { applyOrganizationEdits } from '../../../../src/shared/connection-organization-edits'
import { afterEach, expect, test } from 'bun:test'
import { settingsApi } from '@/api/settings'
import type { AppStore, SettingsSlice } from '@/types/store'
import { createSettingsSlice, flushSettingsNow, resetSettingsPersistence, shouldReloadSettingsAfterUpdate } from './settings'

const originalFetch = globalThis.fetch
const original = { getAll: settingsApi.getAll, putMany: settingsApi.putMany }
const library = {
  folders: [{ id: 'local', name: 'Local' }], folderOrder: ['local', ''], assignments: { a: 'local' },
}

function setup() {
  const rows = new Map<string, unknown>([
    ['connectionLibraries', { llm: library, imageGen: library }],
    ['recentConnections', { llm: ['a'], imageGen: ['b'] }],
  ])
  settingsApi.getAll = async () => [...rows].map(([key, value]) => ({ key, value, updated_at: 1 }))
  settingsApi.putMany = async values => {
    for (const [key, value] of Object.entries(values)) rows.set(key, value)
    return Object.entries(values).map(([key, value]) => ({ key, value, updated_at: 1 }))
  }
  globalThis.fetch = (async (input, init) => {
    const path = String(input)
    if (path.endsWith('/connections/organization/edit')) {
      const values = applyOrganizationEdits(Object.fromEntries(rows), JSON.parse(String(init?.body)))
      for (const [key, value] of Object.entries(values)) rows.set(key, value)
      return Response.json(values)
    }
    if (path.endsWith('/connections/organization')) return Response.json(Object.fromEntries(rows))
    throw new Error(`Unexpected fetch ${path}`)
  }) as typeof fetch
  const app = {} as AppStore
  const set = (patch: Partial<SettingsSlice>) => Object.assign(app, patch)
  Object.assign(app, createSettingsSlice(set as never, () => app, {} as never))
  return { app, rows }
}

afterEach(() => {
  resetSettingsPersistence()
  globalThis.fetch = originalFetch
  localStorage.removeItem('__lumiverse_pending_settings')
  settingsApi.getAll = original.getAll
  settingsApi.putMany = original.putMany
})

test('settings reload keeps remote moves to Uncategorized and removal of a type', async () => {
  const { app, rows } = setup()
  await app.loadSettings()
  expect(app.connectionLibraries.llm?.assignments.a).toBe('local')
  const saved = { llm: { ...library, assignments: {} } }
  rows.set('connectionLibraries', saved)
  rows.set('recentConnections', { llm: [] })
  await app.loadSettings()
  expect(app.connectionLibraries).toEqual(saved)
  expect(app.recentConnections).toEqual({ llm: [] })

  app.setSetting('connectionLibraries', {
    ...app.connectionLibraries, llm: { ...app.connectionLibraries.llm!, folderOrder: ['', 'local'] },
  })
  await flushSettingsNow()
  expect(rows.get('connectionLibraries')).toEqual({ llm: { ...saved.llm, folderOrder: ['', 'local'] } })
})

test('reload ignores obsolete browser organization backups and uses backend state', async () => {
  const { app, rows } = setup()
  const pending = { llm: { ...library, assignments: {} } }
  localStorage.setItem('__lumiverse_pending_settings', JSON.stringify({ connectionLibraries: pending, recentConnections: {} }))
  await app.loadSettings()
  await flushSettingsNow()
  expect(app.connectionLibraries).toEqual({ llm: library, imageGen: library })
  expect(rows.get('connectionLibraries')).toEqual({ llm: library, imageGen: library })
  expect(app.recentConnections).toEqual({ llm: ['a'], imageGen: ['b'] })
})

test('a folder edit made during settings loading survives an older response', async () => {
  const { app } = setup()
  await app.loadSettings()
  let resolveRows!: (rows: Awaited<ReturnType<typeof settingsApi.getAll>>) => void
  settingsApi.getAll = () => new Promise(resolve => { resolveRows = resolve })
  const loading = app.loadSettings()
  const next = { llm: { ...library, assignments: {} } }
  app.setSetting('connectionLibraries', next)
  resolveRows([{ key: 'connectionLibraries', value: { llm: library }, updated_at: 1 }])
  await loading
  expect(app.connectionLibraries).toEqual(next)
})


test('an old settings GET cannot overwrite a completed organization write', async () => {
  const { app } = setup(); await app.loadSettings()
  let finishPost!: (value: Response) => void
  globalThis.fetch = Object.assign(() => new Promise<Response>(resolve => { finishPost = resolve }), { preconnect: originalFetch.preconnect })
  const next = { llm: { ...library, assignments: {} } }
  app.setSetting('connectionLibraries', next)
  let finishGet!: (rows: Awaited<ReturnType<typeof settingsApi.getAll>>) => void
  settingsApi.getAll = () => new Promise(resolve => { finishGet = resolve })
  const loading = app.loadSettings()
  // Deferred reconciliation reads the current authoritative result.
  settingsApi.getAll = async () => [{ key: 'connectionLibraries', value: next, updated_at: 1 }]
  finishPost(Response.json({ connectionLibraries: next, connectionsOrder: {}, recentConnections: {} }))
  await flushSettingsNow()
  finishGet([{ key: 'connectionLibraries', value: {}, updated_at: 1 }]); await loading
  expect(app.connectionLibraries).toEqual(next)
})

test('a remote folder seen while writing is refreshed after the queue drains', async () => {
  const { app } = setup(); await app.loadSettings()
  let finishPost!: (value: Response) => void
  globalThis.fetch = Object.assign(() => new Promise<Response>(resolve => { finishPost = resolve }), { preconnect: originalFetch.preconnect })
  const next = { llm: { ...library, assignments: {} } }
  app.setSetting('connectionLibraries', next)
  const remote = { ...next, tts: library }
  settingsApi.getAll = async () => [{ key: 'connectionLibraries', value: remote, updated_at: 1 }]
  expect(shouldReloadSettingsAfterUpdate({ keys: ['connectionLibraries'] })).toBe(false)
  finishPost(Response.json({ connectionLibraries: next, connectionsOrder: {}, recentConnections: {} }))
  await flushSettingsNow(); await Bun.sleep(0)
  expect(app.connectionLibraries).toEqual(remote)
})
