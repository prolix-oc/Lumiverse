import { describe, expect, test, vi } from 'bun:test'
import type { Preset, UpdatePresetInput } from '@/types/api'
import type { LoomPreset } from './types'
import {
  createPresetSaveCoordinator,
  flushPresetForGeneration,
  setPresetSaveCoordinatorScope,
  presetSaveCoordinator,
  StalePresetHydrationError,
  PresetScopeChangedError,
  PresetBlockConflictError,
  type PresetSaveAdapter,
} from './preset-save-coordinator'
import { unmarshalPreset } from './service'
import { presetsApi } from '@/api/presets'

function rawPreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: 'preset-1',
    name: 'Coordinator test',
    provider: 'loom',
    parameters: {},
    prompt_order: [],
    prompts: {},
    metadata: {},
    created_at: 1,
    updated_at: 2,
    ...overrides,
  }
}

function persistedFromUpdate(presetId: string, input: UpdatePresetInput): Preset {
  return rawPreset({
    id: presetId,
    name: input.name ?? 'Coordinator test',
    parameters: input.parameters ?? {},
    prompt_order: input.prompt_order ?? [],
    prompts: input.prompts ?? {},
    metadata: input.metadata ?? {},
    updated_at: Date.now(),
  })
}

describe('preset save coordinator', () => {
  test('serializes a stale editor writer and a later prompt-variable writer', async () => {
    const writes: UpdatePresetInput[] = []
    const adapter: PresetSaveAdapter = {
      async update(presetId, input) {
        writes.push(structuredClone(input))
        return persistedFromUpdate(presetId, input)
      },
    }
    const coordinator = createPresetSaveCoordinator(adapter)
    const base = unmarshalPreset(rawPreset())
    coordinator.hydrate(base)

    coordinator.mutate(
      base.id,
      base,
      (preset) => ({
        ...preset,
        blocks: [{
          id: 'block-1',
          name: 'Editor block',
          content: 'editor update',
          role: 'system',
          enabled: true,
          position: 'pre_history',
          depth: 0,
          marker: null,
          isLocked: false,
          color: null,
          injectionTrigger: [],
          variables: [{
            id: 'tone',
            name: 'tone',
            label: 'Tone',
            type: 'text',
            defaultValue: '',
          }],
        }],
      }),
      { immediate: true },
    )
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({
        ...preset,
        promptVariables: { 'block-1': { tone: 'warm' } },
      }),
      { immediate: true },
    )

    await coordinator.flush(base.id)

    expect(writes).toHaveLength(2)
    expect(writes[1].prompt_order).toHaveLength(1)
    expect(writes[1].metadata?.promptVariables).toEqual({ 'block-1': { tone: 'warm' } })
  })
  test('retains same-tick functional block updates over the coordinator draft', async () => {
    const writes: UpdatePresetInput[] = []
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        writes.push(structuredClone(input))
        return persistedFromUpdate(presetId, input)
      },
    })
    const base = unmarshalPreset(rawPreset())
    coordinator.hydrate(base)
    const firstBlock: LoomPreset['blocks'][number] = {
      id: 'block-1',
      name: 'Added block',
      content: 'initial content',
      role: 'system',
      enabled: true,
      position: 'pre_history',
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
    }

    const added = coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, blocks: [...preset.blocks, firstBlock] }),
      { immediate: true },
    )
    const updated = coordinator.mutate(
      base.id,
      base,
      (preset) => ({
        ...preset,
        blocks: preset.blocks.map((block) => (
          block.id === firstBlock.id ? { ...block, name: 'Updated block' } : block
        )),
      }),
      { immediate: true },
    )

    expect(added.blocks).toEqual([firstBlock])
    expect(updated.blocks).toEqual([{ ...firstBlock, name: 'Updated block' }])
    expect(coordinator.getDraft(base.id)?.blocks).toEqual(updated.blocks)

    await coordinator.flush(base.id)

    expect(writes).toHaveLength(2)
    expect(writes[1].prompt_order?.[0]).toMatchObject({
      id: firstBlock.id,
      name: 'Updated block',
    })
  })

  test('flush waits for a mutation queued while an earlier write is in flight', async () => {
    const writes: UpdatePresetInput[] = []
    let resolveFirst!: (preset: Preset) => void
    let resolveSecond!: (preset: Preset) => void
    let markFirstStarted!: () => void
    let markSecondStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve })
    let callCount = 0
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        writes.push(structuredClone(input))
        callCount += 1
        if (callCount === 1) {
          markFirstStarted()
          return new Promise<Preset>((resolve) => { resolveFirst = resolve })
        }
        markSecondStarted()
        return new Promise<Preset>((resolve) => { resolveSecond = resolve })
      },
    })
    const base = unmarshalPreset(rawPreset())
    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, name: 'First write' }),
      { immediate: true },
    )
    await firstStarted
    let flushed = false
    const flushing = coordinator.flush(base.id).then(() => { flushed = true })
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, description: 'Second write' }),
      { immediate: true },
    )
    resolveFirst(persistedFromUpdate(base.id, writes[0]))
    await secondStarted
    expect(flushed).toBe(false)
    resolveSecond(persistedFromUpdate(base.id, writes[1]))
    await flushing
    expect(writes).toHaveLength(2)
    expect(writes[1].name).toBe('First write')
    expect(writes[1].metadata?.description).toBe('Second write')
  })

  test('rebases only locally-owned dirty fields over a fresh persisted row', async () => {
    const adapter: PresetSaveAdapter = {
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    }
    const coordinator = createPresetSaveCoordinator(adapter)
    const base = unmarshalPreset(rawPreset({
      metadata: { agentic_preset_composer: { mode: 'single' } },
    }))
    coordinator.hydrate(base)

    coordinator.mutate(
      base.id,
      base,
      (preset) => ({
        ...preset,
        promptVariables: { 'block-1': { tone: 'warm' } },
      }),
      { immediate: true },
    )

    const rebased = coordinator.hydrate(unmarshalPreset(rawPreset({
      metadata: { agentic_preset_composer: { mode: 'parallel' } },
      updated_at: 3,
    })))

    expect(rebased.promptVariables).toEqual({ 'block-1': { tone: 'warm' } })
    expect(rebased.passthroughMetadata.agentic_preset_composer).toEqual({ mode: 'parallel' })
    await coordinator.flush(base.id)
  })

  test('preserves independent passthrough namespaces during a scoped rebase', async () => {
    const adapter: PresetSaveAdapter = {
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    }
    const coordinator = createPresetSaveCoordinator(adapter)
    const base = unmarshalPreset(rawPreset({
      metadata: {
        first_extension: { enabled: false },
        second_extension: { revision: 1 },
      },
    }))
    coordinator.hydrate(base)

    coordinator.mutate(
      base.id,
      base,
      (preset) => ({
        ...preset,
        passthroughMetadata: {
          ...preset.passthroughMetadata,
          first_extension: { enabled: true },
        },
      }),
      { immediate: true },
    )

    const rebased = coordinator.hydrate(unmarshalPreset(rawPreset({
      metadata: {
        first_extension: { enabled: false },
        second_extension: { revision: 2 },
      },
      updated_at: 4,
    })))

    expect(rebased.passthroughMetadata).toEqual({
      first_extension: { enabled: true },

      second_extension: { revision: 2 },
    })
    await coordinator.flush(base.id)
  })

  test('rebases a durable prompt-only envelope over the fresh persisted row', () => {
    localStorage.clear()
    const base = unmarshalPreset(rawPreset({
      metadata: { agentic_preset_composer: { mode: 'single' } },
    }))
    const pending = {
      ...base,
      promptVariables: { 'block-1': { tone: 'warm' } },
    }
    localStorage.setItem('__lumiverse_pending_loom_presets', JSON.stringify({
      [base.id]: {
        __lumiverse_pending_loom_preset_v2: 2,
        preset: pending,
        dirty: { fields: ['promptVariables'], passthroughKeys: [] },
        revision: 1,
      },
    }))

    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })
    const rebased = coordinator.hydrate(unmarshalPreset(rawPreset({
      metadata: { agentic_preset_composer: { mode: 'parallel' } },
      updated_at: 5,
    })))

    expect(rebased.promptVariables).toEqual({ 'block-1': { tone: 'warm' } })
    expect(rebased.passthroughMetadata.agentic_preset_composer).toEqual({ mode: 'parallel' })
    localStorage.clear()
  })

  test('migrates a legacy raw snapshot without replaying prompt or extension state', () => {
    localStorage.clear()
    const persisted = unmarshalPreset(rawPreset({
      metadata: {
        agentic_preset_composer: { mode: 'parallel' },
        promptVariables: { 'block-1': { tone: 'fresh' } },
      },
      updated_at: 6,
    }))
    const legacy = {
      ...persisted,
      name: 'Unsaved editor name',
      promptVariables: { 'block-1': { tone: 'stale' } },
      passthroughMetadata: { agentic_preset_composer: { mode: 'single' } },
    }
    localStorage.setItem('__lumiverse_pending_loom_presets', JSON.stringify({
      [persisted.id]: legacy,
    }))

    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })
    const rebased = coordinator.hydrate(persisted)

    expect(rebased.name).toBe('Unsaved editor name')
    expect(rebased.promptVariables).toEqual({ 'block-1': { tone: 'fresh' } })
    expect(rebased.passthroughMetadata.agentic_preset_composer).toEqual({ mode: 'parallel' })
    localStorage.clear()
  })

  test('migrates an unscoped legacy draft after selecting the authenticated scope', () => {
    localStorage.clear()
    const persisted = unmarshalPreset(rawPreset({
      name: 'Persisted name',
      cache_revision: 2,
    }))
    const legacy = {
      ...persisted,
      name: 'Legacy unsaved name',
    }
    localStorage.setItem('__lumiverse_pending_loom_presets', JSON.stringify({
      [persisted.id]: legacy,
    }))

    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })
    coordinator.setScope('legacy-user')

    expect(coordinator.hydrate(persisted).name).toBe('Legacy unsaved name')
    expect(localStorage.getItem('__lumiverse_pending_loom_presets:legacy-user')).not.toBeNull()
    expect(localStorage.getItem('__lumiverse_pending_loom_presets')).toBeNull()
    coordinator.setScope(null)
    localStorage.clear()
  })

  test('rebases a durable extension key over fresh sibling extension keys', async () => {
    localStorage.clear()
    const writes: UpdatePresetInput[] = []
    const persisted = unmarshalPreset(rawPreset({
      metadata: {
        first_extension: { mode: 'old' },
        second_extension: { revision: 2 },
      },
    }))
    const pending = {
      ...persisted,
      passthroughMetadata: {
        ...persisted.passthroughMetadata,
        first_extension: { mode: 'new' },
        second_extension: { revision: 1 },
      },
    }
    localStorage.setItem('__lumiverse_pending_loom_presets', JSON.stringify({
      [persisted.id]: {
        __lumiverse_pending_loom_preset_v2: 2,
        preset: pending,
        dirty: {
          fields: [],
          passthroughKeys: ['first_extension'],
        },
        revision: 1,
      },
    }))
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        writes.push(structuredClone(input))
        return persistedFromUpdate(presetId, input)
      },
    })

    expect(coordinator.hasDurablePendingRecovery(persisted.id)).toBe(true)
    const rebased = coordinator.hydrate(persisted)
    expect(coordinator.hasDurablePendingRecovery(persisted.id)).toBe(false)
    expect(rebased.passthroughMetadata.first_extension).toEqual({ mode: 'new' })
    expect(rebased.passthroughMetadata.second_extension).toEqual({ revision: 2 })
    await coordinator.flush(persisted.id)
    expect(writes[0].metadata?.first_extension).toEqual({ mode: 'new' })
    expect(writes[0].metadata?.second_extension).toEqual({ revision: 2 })
    localStorage.clear()
  })

  test('rebases only a dirty extension key over fresh sibling extension keys', async () => {
    const writes: UpdatePresetInput[] = []
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        writes.push(structuredClone(input))
        return persistedFromUpdate(presetId, input)
      },
    })
    const base = unmarshalPreset(rawPreset({
      metadata: {
        first_extension: { mode: 'old' },
        second_extension: { revision: 1 },
      },
    }))
    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({
        ...preset,
        passthroughMetadata: {
          ...preset.passthroughMetadata,
          first_extension: { mode: 'new' },
          second_extension: { revision: 1 },
        },
      }),
    )

    const rebased = coordinator.hydrate(unmarshalPreset(rawPreset({
      metadata: {
        first_extension: { mode: 'old' },
        second_extension: { revision: 2 },
      },
    })))
    expect(rebased.passthroughMetadata.first_extension).toEqual({ mode: 'new' })
    expect(rebased.passthroughMetadata.second_extension).toEqual({ revision: 2 })
    await coordinator.flush(base.id)
    expect(writes[0].metadata?.first_extension).toEqual({ mode: 'new' })
    expect(writes[0].metadata?.second_extension).toEqual({ revision: 2 })
  })

  test('evicts a clean no-subscriber entry after persistence completes', async () => {
    localStorage.clear()
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })
    const base = unmarshalPreset(rawPreset())
    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, description: 'Saved without a subscriber' }),
      { immediate: true },
    )

    await coordinator.flush(base.id)
    await Promise.resolve()
    expect(coordinator.getDraft(base.id)).toBeNull()
    localStorage.clear()
  })

  test('rejects a delayed persisted read after a newer write was confirmed', async () => {
    localStorage.clear()
    const writes: UpdatePresetInput[] = []
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        writes.push(structuredClone(input))
        return persistedFromUpdate(presetId, input)
      },
    })
    const base = unmarshalPreset(rawPreset({ name: 'Before delayed read' }))
    coordinator.hydrate(base)

    const delayedRead = coordinator.beginHydration(base.id)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, name: 'Saved before delayed read resolves' }),
      { immediate: true },
    )
    await coordinator.flush(base.id)

    const afterDelayedRead = coordinator.hydrate(base, delayedRead)
    expect(afterDelayedRead.name).toBe('Saved before delayed read resolves')

    coordinator.mutate(
      base.id,
      afterDelayedRead,
      (preset) => ({ ...preset, promptVariables: { 'block-1': { tone: 'warm' } } }),
      { immediate: true },
    )
    await coordinator.flush(base.id)

    expect(writes).toHaveLength(2)
    expect(writes[1].name).toBe('Saved before delayed read resolves')
    localStorage.clear()
  })

  test('allows only the latest concurrently started hydration to establish a draft', async () => {
    localStorage.clear()
    const writes: UpdatePresetInput[] = []
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        writes.push(structuredClone(input))
        return persistedFromUpdate(presetId, input)
      },
    })
    const stale = unmarshalPreset(rawPreset({ name: 'Stale read', updated_at: 1 }))
    const fresh = unmarshalPreset(rawPreset({ name: 'Fresh read', updated_at: 2 }))

    const firstRead = coordinator.beginHydration(stale.id)
    const secondRead = coordinator.beginHydration(fresh.id)
    expect(() => coordinator.hydrate(stale, firstRead)).toThrow(StalePresetHydrationError)

    const loaded = coordinator.hydrate(fresh, secondRead)
    const edited = coordinator.mutate(
      loaded.id,
      loaded,
      (preset) => ({ ...preset, description: 'Locally edited after the fresh read' }),
      { immediate: true },
    )
    await coordinator.flush(edited.id)

    expect(writes).toHaveLength(1)
    expect(writes[0].name).toBe('Fresh read')
    expect(writes[0].metadata?.description).toBe('Locally edited after the fresh read')
    localStorage.clear()
  })

  test('keeps an editor hydration usable when a later auxiliary read fails', () => {
    localStorage.clear()
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })
    const editorRow = unmarshalPreset(rawPreset({ name: 'Editor row', updated_at: 1 }))
    const unsubscribe = coordinator.subscribe(editorRow.id, () => {})
    const editorRead = coordinator.beginHydration(editorRow.id, 'loom-editor')
    const promptRead = coordinator.beginHydration(editorRow.id, 'prompt-variables')

    const editorDraft = coordinator.hydrate(editorRow, editorRead)
    expect(editorDraft.name).toBe('Editor row')
    // The prompt-variable request intentionally never resolves. The selected
    // editor still owns a usable persisted draft rather than remaining blank.
    expect(coordinator.getDraft(editorRow.id)?.name).toBe('Editor row')

    const freshPromptRow = unmarshalPreset(rawPreset({ name: 'Fresh prompt row', updated_at: 2 }))
    const promptDraft = coordinator.hydrate(freshPromptRow, promptRead)
    expect(promptDraft.name).toBe('Fresh prompt row')
    expect(coordinator.hydrate(editorRow, editorRead).name).toBe('Fresh prompt row')
    unsubscribe()
    localStorage.clear()
  })

  test('rebases a local dirty mutation over the latest in-flight persisted read', async () => {
    localStorage.clear()
    const writes: UpdatePresetInput[] = []
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        writes.push(structuredClone(input))
        return persistedFromUpdate(presetId, input)
      },
    })
    const base = unmarshalPreset(rawPreset({ name: 'Base', updated_at: 1 }))
    coordinator.hydrate(base)
    const read = coordinator.beginHydration(base.id)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, promptVariables: { 'block-1': { tone: 'warm' } } }),
    )

    const rebased = coordinator.hydrate(
      unmarshalPreset(rawPreset({ name: 'Fresh base', updated_at: 2 })),
      read,
    )
    await coordinator.flush(base.id)

    expect(rebased.name).toBe('Fresh base')
    expect(rebased.promptVariables).toEqual({ 'block-1': { tone: 'warm' } })
    expect(writes).toHaveLength(1)
    expect(writes[0].name).toBe('Fresh base')
    localStorage.clear()
  })

  test('rejects a delayed read after a direct authoritative hydration', () => {
    localStorage.clear()
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })
    const old = unmarshalPreset(rawPreset({ name: 'Old row', updated_at: 1 }))
    coordinator.hydrate(old)
    const delayedRead = coordinator.beginHydration(old.id)

    const current = coordinator.hydrate(unmarshalPreset(rawPreset({
      name: 'Authoritative row',
      updated_at: 2,
    })))
    const afterDelayedRead = coordinator.hydrate(old, delayedRead)

    expect(current.name).toBe('Authoritative row')
    expect(afterDelayedRead.name).toBe('Authoritative row')
    localStorage.clear()
  })

  test('notifies a subscription registered before the first hydration', () => {
    localStorage.clear()
    const base = unmarshalPreset(rawPreset())
    const observed: LoomPreset[] = []
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })

    const unsubscribe = coordinator.subscribe(base.id, (preset) => observed.push(preset))
    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({
        ...preset,
        promptVariables: { 'block-1': { tone: 'warm' } },
      }),
      { immediate: true },
    )

    expect(observed).toHaveLength(2)
    expect(observed[1].promptVariables).toEqual({ 'block-1': { tone: 'warm' } })
    unsubscribe()
    localStorage.clear()
  })

  test('does not let a stale cleanup erase a replacement pre-hydration listener', () => {
    localStorage.clear()
    const base = unmarshalPreset(rawPreset())
    const received: LoomPreset[] = []
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })

    const staleUnsubscribe = coordinator.subscribe(base.id, () => {})
    coordinator.remove(base.id)
    const currentUnsubscribe = coordinator.subscribe(base.id, (preset) => received.push(preset))
    staleUnsubscribe()
    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, name: 'Current subscriber receives this' }),
      { immediate: true },
    )

    expect(received).toHaveLength(2)
    expect(received[1].name).toBe('Current subscriber receives this')
    currentUnsubscribe()
    localStorage.clear()
  })

  test('evicts a clean preset once its final listener unsubscribes', () => {
    localStorage.clear()
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })
    const base = unmarshalPreset(rawPreset())
    const unsubscribe = coordinator.subscribe(base.id, () => {})
    coordinator.hydrate(base)
    expect(coordinator.getDraft(base.id)).not.toBeNull()

    unsubscribe()
    expect(coordinator.getDraft(base.id)).toBeNull()
    localStorage.clear()
  })

  test('single-flights concurrent durable recovery before generation', async () => {
    const presetId = 'single-flight-recovery'
    const persisted = rawPreset({ id: presetId })
    const originalGet = presetsApi.get
    const originalUpdate = presetsApi.update
    let getCalls = 0
    let resolveGet!: (preset: Preset) => void
    const pendingGet = new Promise<Preset>((resolve) => { resolveGet = resolve })
    presetSaveCoordinator.remove(presetId)
    localStorage.setItem('__lumiverse_pending_loom_presets', JSON.stringify({
      [presetId]: {
        __lumiverse_pending_loom_preset_v2: 2,
        preset: unmarshalPreset(persisted),
        dirty: { fields: ['description'], passthroughKeys: [] },
        revision: 0,
      },
    }))
    ;(presetsApi as any).get = async () => {
      getCalls += 1
      return pendingGet
    }
    ;(presetsApi as any).update = async (id: string, input: UpdatePresetInput) => persistedFromUpdate(id, input)

    try {
      const first = flushPresetForGeneration(presetId)
      const second = flushPresetForGeneration(presetId)
      await Promise.resolve()
      expect(getCalls).toBe(1)

      resolveGet(persisted)
      await Promise.all([first, second])
    } finally {
      ;(presetsApi as any).get = originalGet
      ;(presetsApi as any).update = originalUpdate
      presetSaveCoordinator.remove(presetId)
      localStorage.removeItem('__lumiverse_pending_loom_presets')
    }
  })
  test('rejects generation flush when the user scope switches mid-write', async () => {
    const presetId = 'scope-generation-preset'
    const persisted = rawPreset({ id: presetId })
    const originalUpdate = presetsApi.update
    let resolveUpdate!: (preset: Preset) => void
    const pendingUpdate = new Promise<Preset>((resolve) => { resolveUpdate = resolve })

    presetSaveCoordinator.setScope('generation-user-a')
    presetSaveCoordinator.hydrate(unmarshalPreset(persisted))
    ;(presetsApi as any).update = async () => pendingUpdate

    try {
      presetSaveCoordinator.mutate(
        presetId,
        unmarshalPreset(persisted),
        (preset) => ({ ...preset, description: 'pending generation write' }),
        { immediate: true },
      )
      const flush = flushPresetForGeneration(presetId)
      await Promise.resolve()
      presetSaveCoordinator.setScope('generation-user-b')
      resolveUpdate(persisted)
      await expect(flush).rejects.toBeInstanceOf(PresetScopeChangedError)
    } finally {
      ;(presetsApi as any).update = originalUpdate
      presetSaveCoordinator.setScope(null)
      presetSaveCoordinator.remove(presetId)
      localStorage.clear()
    }
  })
  test('scopes recovery and drops deferred writes across user changes', () => {
    localStorage.clear()
    vi.useFakeTimers()
    let updates = 0
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        updates += 1
        return persistedFromUpdate(presetId, input)
      },
    })
    const base = unmarshalPreset(rawPreset())

    try {
      coordinator.setScope('user-a')
      coordinator.mutate(base.id, base, (preset) => ({
        ...preset,
        description: 'private to user A',
      }))

      expect(localStorage.getItem('__lumiverse_pending_loom_presets:user-a')).not.toBeNull()
      coordinator.setScope('user-b')
      expect(coordinator.getDraft(base.id)).toBeNull()
      expect(coordinator.hasDurablePendingRecovery(base.id)).toBe(false)
      expect(localStorage.getItem('__lumiverse_pending_loom_presets:user-a')).not.toBeNull()
      expect(localStorage.getItem('__lumiverse_pending_loom_presets:user-b')).toBeNull()
      vi.advanceTimersByTime(401)
      expect(updates).toBe(0)

      coordinator.setScope('user-a')
      expect(coordinator.hasDurablePendingRecovery(base.id)).toBe(true)
    } finally {
      coordinator.setScope(null)
      localStorage.clear()
      vi.useRealTimers()
    }
  })
  test('rebases local edits after a revision conflict before retrying', async () => {
    localStorage.clear()
    const base = unmarshalPreset(rawPreset({
      name: 'Base name',
      metadata: { external: { value: 'base' } },
      cache_revision: 3,
    }))
    const latestPersisted = rawPreset({
      name: 'Remote name',
      metadata: {
        external: { value: 'remote' },
        remoteOnly: { enabled: true },
      },
      cache_revision: 4,
      updated_at: 5,
    })
    const writes: UpdatePresetInput[] = []
    let updateCalls = 0
    let getCalls = 0
    const conflict = Object.assign(new Error('preset revision conflict'), {
      status: 409,
      body: { code: 'PRESET_REVISION_CONFLICT' },
    })
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        writes.push(structuredClone(input))
        updateCalls += 1
        if (updateCalls === 1) throw conflict
        return rawPreset({
          ...latestPersisted,
          id: presetId,
          name: input.name ?? latestPersisted.name,
          parameters: input.parameters ?? latestPersisted.parameters,
          prompt_order: input.prompt_order ?? latestPersisted.prompt_order,
          prompts: input.prompts ?? latestPersisted.prompts,
          metadata: input.metadata ?? latestPersisted.metadata,
          cache_revision: 5,
        })
      },
      async get(presetId) {
        getCalls += 1
        expect(presetId).toBe(base.id)
        return latestPersisted
      },
    })

    const unsubscribe = coordinator.subscribe(base.id, () => {})
    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, name: 'Local name' }),
      { immediate: true },
    )

    const saved = await coordinator.flush(base.id)
    const draft = coordinator.getDraft(base.id)

    expect(getCalls).toBe(1)
    expect(writes).toHaveLength(2)
    expect(writes.map((input) => input.expected_cache_revision)).toEqual([3, 4])
    expect(saved?.name).toBe('Local name')
    expect(saved?.cacheRevision).toBe(5)
    expect(draft?.name).toBe('Local name')
    expect(draft?.passthroughMetadata.external).toEqual({ value: 'remote' })
    expect(draft?.passthroughMetadata.remoteOnly).toEqual({ enabled: true })
    unsubscribe()
    localStorage.clear()
  })

  test('retries block edits when a revision conflict changed unrelated fields only', async () => {
    localStorage.clear()
    const block = {
      id: 'block-a',
      name: 'Block A',
      content: 'base',
      role: 'system' as const,
      enabled: true,
      position: 'pre_history' as const,
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
    }
    const base = unmarshalPreset(rawPreset({
      prompt_order: [block],
      cache_revision: 1,
    }))
    const latest = rawPreset({
      name: 'Remote name',
      prompt_order: [block],
      cache_revision: 2,
    })
    const conflict = Object.assign(new Error('preset revision conflict'), {
      status: 409,
      body: { code: 'PRESET_REVISION_CONFLICT' },
    })
    const writes: UpdatePresetInput[] = []
    let updateCalls = 0
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        writes.push(structuredClone(input))
        updateCalls += 1
        if (updateCalls === 1) throw conflict
        return rawPreset({
          ...latest,
          id: presetId,
          prompt_order: input.prompt_order ?? latest.prompt_order,
          cache_revision: 3,
        })
      },
      async get() {
        return latest
      },
    })
    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({
        ...preset,
        blocks: preset.blocks.map((candidate) => ({ ...candidate, content: 'local' })),
      }),
      { immediate: true },
    )

    await coordinator.flush(base.id)
    expect(writes).toHaveLength(2)
    expect(writes[1].prompt_order?.[0]?.content).toBe('local')
    localStorage.clear()
  })

  test('surfaces a block conflict instead of replaying a stale array', async () => {
    localStorage.clear()
    const baseBlock = {
      id: 'block-a',
      name: 'Block A',
      content: 'base',
      role: 'system' as const,
      enabled: true,
      position: 'pre_history' as const,
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
    }
    const remoteBlock = { ...baseBlock, content: 'remote' }
    const base = unmarshalPreset(rawPreset({
      prompt_order: [baseBlock],
      cache_revision: 1,
    }))
    const latest = rawPreset({
      prompt_order: [remoteBlock],
      cache_revision: 2,
    })
    const conflict = Object.assign(new Error('preset revision conflict'), {
      status: 409,
      body: { code: 'PRESET_REVISION_CONFLICT' },
    })
    const writes: UpdatePresetInput[] = []
    const coordinator = createPresetSaveCoordinator({
      async update(_presetId, input) {
        writes.push(structuredClone(input))
        throw conflict
      },
      async get() {
        return latest
      },
    })
    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({
        ...preset,
        blocks: preset.blocks.map((candidate) => ({ ...candidate, content: 'local' })),
      }),
      { immediate: true },
    )

    await expect(coordinator.flush(base.id)).rejects.toBe(conflict)
    expect(writes).toHaveLength(1)
    localStorage.clear()
  })

  test('uses the post-queue block revision as the retry base', async () => {
    localStorage.clear()
    const block = {
      id: 'block-a',
      name: 'Block A',
      content: 'base',
      role: 'system' as const,
      enabled: true,
      position: 'pre_history' as const,
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
    }
    const base = unmarshalPreset(rawPreset({
      prompt_order: [block],
      cache_revision: 1,
    }))
    const firstSaved = rawPreset({
      ...base,
      prompt_order: [{ ...block, content: 'first' }],
      cache_revision: 2,
    })
    const conflict = Object.assign(new Error('preset revision conflict'), {
      status: 409,
      body: { code: 'PRESET_REVISION_CONFLICT' },
    })
    const writes: UpdatePresetInput[] = []
    let updateCalls = 0
    let markFirstStarted!: () => void
    let resolveFirst!: (preset: Preset) => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        writes.push(structuredClone(input))
        updateCalls += 1
        if (updateCalls === 1) {
          markFirstStarted()
          return new Promise<Preset>((resolve) => { resolveFirst = resolve })
        }
        if (updateCalls === 2) throw conflict
        return rawPreset({
          ...firstSaved,
          id: presetId,
          prompt_order: input.prompt_order ?? firstSaved.prompt_order,
          cache_revision: 3,
        })
      },
      async get() {
        return firstSaved
      },
    })
    coordinator.hydrate(base)
    const unsubscribe = coordinator.subscribe(base.id, () => {})
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({
        ...preset,
        blocks: preset.blocks.map((candidate) => ({ ...candidate, content: 'first' })),
      }),
      { immediate: true },
    )
    await firstStarted
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({
        ...preset,
        blocks: preset.blocks.map((candidate) => ({ ...candidate, content: 'second' })),
      }),
      { immediate: true },
    )
    resolveFirst(firstSaved)
    expect(() => coordinator.hydrate(unmarshalPreset(firstSaved))).not.toThrow()

    await coordinator.flush(base.id)
    expect(writes).toHaveLength(3)
    expect(writes.map((input) => input.expected_cache_revision)).toEqual([1, 2, 2])
    expect(writes[2].prompt_order?.[0]?.content).toBe('second')
    expect(() => coordinator.hydrate(unmarshalPreset(firstSaved))).not.toThrow()
    expect(coordinator.getDraft(base.id)?.blocks[0]?.content).toBe('second')
    unsubscribe()
    localStorage.clear()
  })

  test('surfaces remote block changes during hydration', () => {
    localStorage.clear()
    const block = {
      id: 'block-a',
      name: 'Block A',
      content: 'base',
      role: 'system' as const,
      enabled: true,
      position: 'pre_history' as const,
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
    }
    const base = unmarshalPreset(rawPreset({
      prompt_order: [block],
      cache_revision: 1,
    }))
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })
    coordinator.hydrate(base)
    coordinator.mutate(base.id, base, (preset) => ({
      ...preset,
      blocks: preset.blocks.map((candidate) => ({ ...candidate, content: 'local' })),
    }))

    const remote = unmarshalPreset(rawPreset({
      prompt_order: [{ ...block, content: 'remote' }],
      cache_revision: 2,
    }))
    expect(() => coordinator.hydrate(remote)).toThrow(PresetBlockConflictError)
    expect(coordinator.getDraft(base.id)?.blocks[0]?.content).toBe('local')
    localStorage.clear()
  })

  test('confirms persisted dirty paths individually while retaining newer edits', async () => {
    localStorage.clear()
    const base = unmarshalPreset(rawPreset({
      name: 'Base name',
      metadata: {
        description: 'Base description',
        extension: { value: 'base' },
      },
      cache_revision: 1,
    }))
    const ownEvent = rawPreset({
      name: 'Local name',
      metadata: {
        description: 'Remote description',
        extension: { value: 'remote' },
      },
      cache_revision: 2,
      updated_at: 3,
    })
    const writes: UpdatePresetInput[] = []
    let updateCalls = 0
    let markFirstStarted!: () => void
    let resolveFirst!: (preset: Preset) => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        writes.push(structuredClone(input))
        updateCalls += 1
        if (updateCalls === 1) {
          markFirstStarted()
          return new Promise<Preset>((resolve) => { resolveFirst = resolve })
        }
        return rawPreset({
          ...ownEvent,
          id: presetId,
          name: input.name ?? ownEvent.name,
          parameters: input.parameters ?? ownEvent.parameters,
          prompt_order: input.prompt_order ?? ownEvent.prompt_order,
          prompts: input.prompts ?? ownEvent.prompts,
          metadata: input.metadata ?? ownEvent.metadata,
          cache_revision: 3,
        })
      },
    })

    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({
        ...preset,
        name: 'Local name',
        description: 'Local description',
      }),
      { immediate: true },
    )
    await firstStarted

    const rebased = coordinator.hydrate(unmarshalPreset(ownEvent))
    expect(rebased.name).toBe('Local name')
    expect(rebased.description).toBe('Local description')
    expect(rebased.passthroughMetadata.extension).toEqual({ value: 'remote' })
    expect(coordinator.hasPendingChanges(base.id)).toBe(true)

    resolveFirst(ownEvent)
    await coordinator.flush(base.id)

    expect(writes).toHaveLength(2)
    expect(writes[1].expected_cache_revision).toBe(2)
    expect(writes[1].name).toBe('Local name')
    expect(writes[1].metadata?.description).toBe('Local description')
    expect(writes[1].metadata?.extension).toEqual({ value: 'remote' })
    localStorage.clear()
  })

  test('does not mutate a recreated entry after an in-flight conflict read', async () => {
    localStorage.clear()
    const base = unmarshalPreset(rawPreset({ cache_revision: 1 }))
    const latest = rawPreset({ name: 'Latest persisted', cache_revision: 2 })
    const replacement = unmarshalPreset(rawPreset({ name: 'Replacement', cache_revision: 9 }))
    const conflict = Object.assign(new Error('preset revision conflict'), {
      status: 409,
      body: { code: 'PRESET_REVISION_CONFLICT' },
    })
    let updateCalls = 0
    let getCalls = 0
    let markUpdateStarted!: () => void
    let markGetStarted!: () => void
    let resolveGet!: (preset: Preset) => void
    let resolveGetRow!: (preset: Preset) => void
    const updateStarted = new Promise<void>((resolve) => { markUpdateStarted = resolve })
    const getStarted = new Promise<void>((resolve) => { markGetStarted = resolve })
    const getFinished = new Promise<void>((resolve) => {
      resolveGet = (preset) => { resolveGetRow(preset); resolve() }
    })
    const coordinator = createPresetSaveCoordinator({
      async update() {
        updateCalls += 1
        markUpdateStarted()
        throw conflict
      },
      async get() {
        getCalls += 1
        markGetStarted()
        return new Promise<Preset>((resolve) => { resolveGetRow = resolve })
      },
    })

    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, name: 'Local name' }),
      { immediate: true },
    )
    await updateStarted
    await getStarted

    coordinator.remove(base.id)
    coordinator.subscribe(base.id, () => {})
    coordinator.hydrate(replacement)
    resolveGet(latest)
    await getFinished
    await Promise.resolve()
    await Promise.resolve()

    expect(updateCalls).toBe(1)
    expect(getCalls).toBe(1)
    expect(coordinator.getDraft(base.id)?.name).toBe('Replacement')
    localStorage.clear()
  })
  test('bounds recoverable revision conflict retries', async () => {
    localStorage.clear()
    const base = unmarshalPreset(rawPreset({ cache_revision: 1 }))
    const latest = rawPreset({ cache_revision: 2 })
    const conflict = Object.assign(new Error('preset revision conflict'), {
      status: 409,
      body: { code: 'PRESET_REVISION_CONFLICT' },
    })
    let updateCalls = 0
    let getCalls = 0
    const coordinator = createPresetSaveCoordinator({
      async update() {
        updateCalls += 1
        throw conflict
      },
      async get() {
        getCalls += 1
        return latest
      },
    })

    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, name: 'Local name' }),
      { immediate: true },
    )

    await expect(coordinator.flush(base.id)).rejects.toBe(conflict)
    expect(updateCalls).toBe(4)
    expect(getCalls).toBe(3)
    localStorage.clear()
  })
  test('isolates durable storage scopes per coordinator instance', () => {
    localStorage.clear()
    const first = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })
    const second = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })
    const base = unmarshalPreset(rawPreset())

    try {
      first.setScope('first-user')
      first.mutate(base.id, base, (preset) => ({
        ...preset,
        description: 'private to first user',
      }))
      second.setScope('second-user')
      second.mutate(base.id, base, (preset) => ({
        ...preset,
        description: 'private to second user',
      }))

      expect(localStorage.getItem('__lumiverse_pending_loom_presets:first-user')).not.toBeNull()
      expect(localStorage.getItem('__lumiverse_pending_loom_presets:second-user')).not.toBeNull()

      first.remove(base.id)
      expect(localStorage.getItem('__lumiverse_pending_loom_presets:first-user')).toBeNull()
      expect(localStorage.getItem('__lumiverse_pending_loom_presets:second-user')).not.toBeNull()
    } finally {
      first.setScope(null)
      second.setScope(null)
      localStorage.clear()
    }
  })

  test('rejects hydration tokens from a previous user scope', () => {
    localStorage.clear()
    const coordinator = createPresetSaveCoordinator({
      async update(presetId, input) {
        return persistedFromUpdate(presetId, input)
      },
    })
    const base = unmarshalPreset(rawPreset())

    coordinator.setScope('hydration-user-a')
    const token = coordinator.beginHydration(base.id)
    coordinator.setScope('hydration-user-b')

    expect(() => coordinator.hydrate(base, token)).toThrow(PresetScopeChangedError)
    coordinator.setScope(null)
    localStorage.clear()
  })

  test('rejects durable recovery with scope error when the persisted read fails late', async () => {
    localStorage.clear()
    const presetId = 'scope-rejected-recovery'
    const persisted = rawPreset({ id: presetId })
    const originalGet = presetsApi.get
    let rejectGet!: (error: Error) => void
    let markGetStarted!: () => void
    const getStarted = new Promise<void>((resolve) => { markGetStarted = resolve })
    const pendingGet = new Promise<Preset>((_resolve, reject) => { rejectGet = reject })

    presetSaveCoordinator.setScope('recovery-user-a')
    presetSaveCoordinator.remove(presetId)
    localStorage.setItem('__lumiverse_pending_loom_presets:recovery-user-a', JSON.stringify({
      [presetId]: {
        __lumiverse_pending_loom_preset_v2: 2,
        preset: unmarshalPreset(persisted),
        dirty: { fields: ['description'], passthroughKeys: [] },
        revision: 0,
      },
    }))
    presetsApi.get = async (_presetId: string) => {
      markGetStarted()
      return pendingGet
    }

    try {
      const flush = flushPresetForGeneration(presetId)
      await getStarted
      presetSaveCoordinator.setScope('recovery-user-b')
      rejectGet(new Error('late persisted read failure'))
      await expect(flush).rejects.toBeInstanceOf(PresetScopeChangedError)
    } finally {
      presetsApi.get = originalGet
      presetSaveCoordinator.setScope(null)
      localStorage.clear()
    }
  })
})
