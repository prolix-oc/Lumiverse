import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { create, type StoreApi } from 'zustand'

import type { PaginatedResult, Preset } from '@/types/api'
import type { RegexScript } from '@/types/regex'
import type { RegexSlice } from '@/types/store'
import { getRuntimeAuthorityRevision } from '@/lib/agentRuntimeSelection'
import { applyPresetAuthorityResult, presetSaveCoordinator, setPresetSaveCoordinatorScope } from '@/lib/loom/preset-save-coordinator'
import { unmarshalPreset } from '@/lib/loom/service'

type ListParams = { limit?: number; offset?: number }

const listCalls: ListParams[] = []
let listImpl: (params: ListParams) => PaginatedResult<RegexScript> = () => ({
  data: [],
  total: 0,
  limit: 0,
  offset: 0,
})
let updateImpl: (id: string, input: unknown) => Promise<UpdateResult> = async () => {
  throw new Error('unexpected update')
}
let authorityOperationImpl: (name: string, args: unknown[]) => Promise<any> = async (name) => {
  throw new Error(`unexpected ${name}`)
}

mock.module('@/api/regex', () => ({
  regexApi: {
    list: (params?: ListParams) => {
      listCalls.push(params ?? {})
      return Promise.resolve(listImpl(params ?? {}))
    },
    update: (id: string, input: unknown) => updateImpl(id, input),
    create: (...args: unknown[]) => authorityOperationImpl('create', args),
    remove: (...args: unknown[]) => authorityOperationImpl('remove', args),
    bulkRemove: (...args: unknown[]) => authorityOperationImpl('bulkRemove', args),
    reorder: (...args: unknown[]) => authorityOperationImpl('reorder', args),
    toggle: (...args: unknown[]) => authorityOperationImpl('toggle', args),
    toggleSelected: (...args: unknown[]) => authorityOperationImpl('toggleSelected', args),
    toggleFolder: (...args: unknown[]) => authorityOperationImpl('toggleFolder', args),
    importScripts: (...args: unknown[]) => authorityOperationImpl('importScripts', args),
  },
}))

let createRegexSlice: typeof import('./regex').createRegexSlice
let importRegexPayloadWithAuthority:
  typeof import('@/components/modals/regexImportBatch').importRegexPayloadWithAuthority

beforeAll(async () => {
  ;({ createRegexSlice } = await import('./regex'))
  ;({ importRegexPayloadWithAuthority } = await import('@/components/modals/regexImportBatch'))
})
function authorityPreset(id: string, cacheRevision: number, configRevision: number): Preset {
  return {
    id,
    name: id,
    provider: 'loom',
    engine: 'classic',
    parameters: {},
    prompt_order: [],
    prompts: {},
    metadata: {},
    agent_config: null,
    agent_config_revision: configRevision,
    agent_config_review: null,
    agent_slot_bindings: {},
    agent_task_templates: [],
    created_at: 0,
    updated_at: 0,
    cache_revision: cacheRevision,
  }
}

type UpdateResult = {
  script: RegexScript
  presetAuthorityChanged: boolean
  presetAuthorities: Preset[]
}
function makeScript(index: number): RegexScript {
  return { id: `script-${index}` } as unknown as RegexScript
}

function pageOf(scripts: RegexScript[], params: ListParams): PaginatedResult<RegexScript> {
  const limit = params.limit ?? 1000
  const offset = params.offset ?? 0
  return { data: scripts.slice(offset, offset + limit), total: scripts.length, limit, offset }
}

describe('loadRegexScripts pagination', () => {
  beforeEach(() => {
    listCalls.length = 0
  })

  test('pages past the 1000-row server cap until the list is exhausted', async () => {
    const scripts = Array.from({ length: 2500 }, (_, i) => makeScript(i))
    listImpl = (params) => pageOf(scripts, params)

    const store = create<RegexSlice>()(createRegexSlice)
    await store.getState().loadRegexScripts()

    expect(listCalls).toEqual([
      { limit: 1000, offset: 0 },
      { limit: 1000, offset: 1000 },
      { limit: 1000, offset: 2000 },
    ])
    const loaded = store.getState().regexScripts
    expect(loaded).toHaveLength(2500)
    expect(loaded[0]?.id).toBe('script-0')
    expect(loaded[2499]?.id).toBe('script-2499')
  })

  test('stops after a single page when everything fits', async () => {
    const scripts = Array.from({ length: 12 }, (_, i) => makeScript(i))
    listImpl = (params) => pageOf(scripts, params)

    const store = create<RegexSlice>()(createRegexSlice)
    await store.getState().loadRegexScripts()

    expect(listCalls).toEqual([{ limit: 1000, offset: 0 }])
    expect(store.getState().regexScripts).toHaveLength(12)
  })

  test('does not clobber the store when shouldApply returns false', async () => {
    const scripts = Array.from({ length: 5 }, (_, i) => makeScript(i))
    listImpl = (params) => pageOf(scripts, params)

    const store = create<RegexSlice>()(createRegexSlice)
    const existing = makeScript(999)
    store.setState({ regexScripts: [existing] })
    await store.getState().loadRegexScripts(() => false)

    expect(listCalls).toEqual([{ limit: 1000, offset: 0 }])
    expect(store.getState().regexScripts).toEqual([existing])
  })
})

describe('bound regex runtime authority', () => {
  test('commits a stale-scope bound success before suppressing local state', async () => {
    setPresetSaveCoordinatorScope('regex-scope-a')
    const before = getRuntimeAuthorityRevision()
    const pendingUpdate = Promise.withResolvers<UpdateResult>()
    updateImpl = () => pendingUpdate.promise
    const store = create<RegexSlice>()(createRegexSlice)
    const scopeA = { ...makeScript(1), name: 'Scope A', preset_id: 'preset-a' } as RegexScript
    const scopeB = { ...makeScript(2), name: 'Scope B', preset_id: null } as RegexScript
    store.setState({ regexScripts: [scopeA] })

    const pending = store.getState().updateRegexScript(scopeA.id, { name: 'Persisted A' })
    store.setState({ regexScripts: [scopeB] })
    setPresetSaveCoordinatorScope('regex-scope-b')
    const authorityResult = {
      presetAuthorityChanged: true,
      presetAuthorities: [authorityPreset('preset-a', 2, 3), authorityPreset('preset-b', 5, 8)],
    }
    pendingUpdate.resolve({ script: { ...scopeA, name: 'Persisted A' }, ...authorityResult })
    await pending

    expect(getRuntimeAuthorityRevision()).toBe(before + 1)
    applyPresetAuthorityResult(authorityResult)
    expect(getRuntimeAuthorityRevision()).toBe(before + 2)
    applyPresetAuthorityResult(authorityResult)
    expect(getRuntimeAuthorityRevision()).toBe(before + 2)
    expect(store.getState().regexScripts).toEqual([scopeB])
  })

  test('does not invalidate or publish a stale-scope semantic no-op', async () => {
    setPresetSaveCoordinatorScope('regex-no-op-scope-a')
    const before = getRuntimeAuthorityRevision()
    const pendingUpdate = Promise.withResolvers<UpdateResult>()
    updateImpl = () => pendingUpdate.promise
    const store = create<RegexSlice>()(createRegexSlice)
    const scopeA = { ...makeScript(10), name: 'Scope A no-op', preset_id: 'preset-no-op' } as RegexScript
    const scopeB = { ...makeScript(11), name: 'Scope B', preset_id: null } as RegexScript
    store.setState({ regexScripts: [scopeA] })

    const pending = store.getState().updateRegexScript(scopeA.id, { name: scopeA.name })
    store.setState({ regexScripts: [scopeB] })
    setPresetSaveCoordinatorScope('regex-no-op-scope-b')
    pendingUpdate.resolve({ script: scopeA, presetAuthorityChanged: false, presetAuthorities: [] })
    await pending

    expect(getRuntimeAuthorityRevision()).toBe(before)
    expect(store.getState().regexScripts).toEqual([scopeB])
  })

  test('hydrates every owner once across regex mutation responses while preserving stale or missing local state', async () => {
    const cases: Array<[
      string,
      (store: StoreApi<RegexSlice>, activePresetId: string) => Promise<unknown>,
    ]> = [
      ['create', (store) => store.getState().addRegexScript({ name: 'Created', find_regex: 'x' } as any)],
      ['remove', (store) => store.getState().removeRegexScript('script-1')],
      ['bulkRemove', (store) => store.getState().bulkRemoveRegexScripts(['script-1', 'script-2'])],
      ['reorder', (store) => store.getState().reorderRegexScripts(['script-2', 'script-1'])],
      ['toggle', (store) => store.getState().toggleRegexScript('script-1', true)],
      ['toggleSelected', (store) => store.getState().toggleSelectedRegexScripts(['script-1', 'script-2'], true)],
      ['toggleFolder', (store) => store.getState().toggleRegexFolder('folder', true)],
      ['importScripts', (_store, activePresetId) => importRegexPayloadWithAuthority({ scripts: [] }, activePresetId)],
    ]

    for (const [operation, invoke] of cases) {
      setPresetSaveCoordinatorScope(`regex-authority-${operation}`)
      const ownerA = authorityPreset(`owner-a-${operation}`, 0, 1)
      const ownerB = authorityPreset(`owner-b-${operation}`, 3, 4)
      const ownerC = authorityPreset(`owner-c-${operation}`, 6, 7)
      const publishedA: Array<ReturnType<typeof unmarshalPreset>> = []
      const publishedB: Array<ReturnType<typeof unmarshalPreset>> = []
      const unsubscribeA = presetSaveCoordinator.subscribe(ownerA.id, (preset) => publishedA.push(preset))
      const unsubscribeB = presetSaveCoordinator.subscribe(ownerB.id, (preset) => publishedB.push(preset))
      presetSaveCoordinator.hydrate(unmarshalPreset(ownerA))
      presetSaveCoordinator.hydrate(unmarshalPreset(ownerB))
      const result = {
        presetAuthorityChanged: true,
        presetAuthorities: [
          authorityPreset(ownerA.id, 1, 2),
          authorityPreset(ownerB.id, 4, 5),
          authorityPreset(ownerC.id, 7, 8),
        ],
      }
      authorityOperationImpl = async (name) => {
        expect(name).toBe(operation)
        if (name === 'create') return { script: { ...makeScript(3), preset_id: ownerA.id }, ...result }
        if (name === 'remove') return { success: true, ...result }
        if (name === 'bulkRemove') return { deleted: ['script-1', 'script-2'], count: 2, ...result }
        if (name === 'reorder') return result
        if (name === 'toggle') return { script: { ...makeScript(1), disabled: true, preset_id: ownerA.id }, ...result }
        if (name === 'toggleSelected' || name === 'toggleFolder') {
          return { changedIds: ['script-1', 'script-2'], skippedIds: [], ...result }
        }
        return { imported: 0, skipped: 0, ...result }
      }
      const store = create<RegexSlice>()(createRegexSlice)
      store.setState({ regexScripts: [
        { ...makeScript(1), folder: 'folder', disabled: false },
        { ...makeScript(2), folder: 'folder', disabled: false },
      ] as RegexScript[] })
      const before = getRuntimeAuthorityRevision()
      const pending = invoke(store, ownerA.id)
      const staleLocal = [{ ...makeScript(99), name: `newer-${operation}` } as RegexScript]
      store.setState({ regexScripts: staleLocal })
      await pending

      expect(getRuntimeAuthorityRevision(), operation).toBe(before + 1)
      expect(publishedA.at(-1)?.cacheRevision, operation).toBe(1)
      expect(publishedA.at(-1)?.agentConfigRevision, operation).toBe(2)
      expect(publishedB.at(-1)?.cacheRevision, operation).toBe(4)
      expect(publishedB.at(-1)?.agentConfigRevision, operation).toBe(5)
      expect(presetSaveCoordinator.getDraft(ownerC.id), operation).toBeNull()
      expect(store.getState().regexScripts, operation).toEqual(staleLocal)
      applyPresetAuthorityResult(result)
      expect(getRuntimeAuthorityRevision(), operation).toBe(before + 1)
      unsubscribeA()
      unsubscribeB()
    }
  })
  test('does not commit a bound semantic no-op with operational response changes', async () => {
    const before = getRuntimeAuthorityRevision()
    const store = create<RegexSlice>()(createRegexSlice)
    const bound = {
      ...makeScript(3),
      name: 'Bound',
      preset_id: 'preset-a',
      metadata: { nested: { alpha: 1, beta: 2 }, regex_performance: { elapsed: 9 } },
      updated_at: 1,
    } as RegexScript
    store.setState({ regexScripts: [bound] })
    updateImpl = async () => ({
      script: {
        ...bound,
        metadata: { nested: { beta: 2, alpha: 1 }, regex_evidence: { elapsed: 10 } },
        updated_at: 2,
      },
      presetAuthorityChanged: false,
      presetAuthorities: [],
    })

    await store.getState().updateRegexScript(bound.id, { name: bound.name })

    expect(getRuntimeAuthorityRevision()).toBe(before)
  })

  test('does not commit unbound or failed dedicated updates', async () => {
    const before = getRuntimeAuthorityRevision()
    const store = create<RegexSlice>()(createRegexSlice)
    const unbound = { ...makeScript(3), name: 'Unbound', preset_id: null } as RegexScript
    store.setState({ regexScripts: [unbound] })
    updateImpl = async () => ({
      script: { ...unbound, name: 'Updated unbound' },
      presetAuthorityChanged: false,
      presetAuthorities: [],
    })
    await store.getState().updateRegexScript(unbound.id, { name: 'Updated unbound' })
    expect(getRuntimeAuthorityRevision()).toBe(before)

    updateImpl = async () => { throw new Error('failed update') }
    await expect(store.getState().updateRegexScript(unbound.id, { name: 'Rejected' })).rejects.toThrow('failed update')
    expect(getRuntimeAuthorityRevision()).toBe(before)
  })
})
