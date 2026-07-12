import { describe, expect, test } from 'bun:test'
import type { Preset, UpdatePresetInput } from '@/types/api'
import { createPresetSaveCoordinator, type PresetSaveAdapter } from './preset-save-coordinator'
import { unmarshalPreset } from './service'

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
})
