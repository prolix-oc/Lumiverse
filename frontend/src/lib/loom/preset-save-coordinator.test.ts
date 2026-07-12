import { describe, expect, test } from 'bun:test'
import type { Preset, UpdatePresetInput } from '@/types/api'
import type { LoomPreset } from './types'
import {
  createPresetSaveCoordinator,
  flushPresetForGeneration,
  presetSaveCoordinator,
  StalePresetHydrationError,
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
})
