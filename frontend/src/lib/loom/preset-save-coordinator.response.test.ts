import { afterEach, describe, expect, test } from 'bun:test'
import type { Preset, UpdatePresetInput } from '@/types/api'
import { createPresetSaveCoordinator, type PresetSaveAdapter } from './preset-save-coordinator'
import { unmarshalPreset } from './service'

function rawPreset(metadata: Record<string, unknown>, cacheRevision?: number): Preset {
  return {
    id: 'preset-response-1',
    name: 'Coordinator response test',
    provider: 'loom',
    parameters: {},
    prompt_order: [],
    prompts: {},
    metadata,
    created_at: 1,
    updated_at: 2,
    ...(cacheRevision === undefined ? {} : { cache_revision: cacheRevision }),
  }
}

afterEach(() => localStorage.clear())

describe('preset save coordinator response preservation', () => {
  test('keeps passthrough siblings when an update response omits them', async () => {
    let sent: UpdatePresetInput | null = null
    const adapter: PresetSaveAdapter = {
      async update(_presetId, input) {
        sent = structuredClone(input)
        return rawPreset({
          description: input.metadata?.description ?? '',
        })
      },
    }
    const coordinator = createPresetSaveCoordinator(adapter)
    const unsubscribe = coordinator.subscribe('preset-response-1', () => {})
    const base = unmarshalPreset(rawPreset({
      agentic_preset_composer: { mode: 'parallel' },
      unrelated_extension: { enabled: true },
    }))
    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, description: 'Updated description' }),
      { immediate: true },
    )

    await coordinator.flush(base.id)

    expect(sent?.metadata?.agentic_preset_composer).toEqual({ mode: 'parallel' })
    expect(coordinator.getDraft(base.id)?.passthroughMetadata).toEqual({
      agentic_preset_composer: { mode: 'parallel' },
      unrelated_extension: { enabled: true },
    })
    unsubscribe()
  })

  test('does not requeue an in-flight save when its normalized websocket echo arrives first', async () => {
    let resolveUpdate!: (preset: Preset) => void
    const updateGate = new Promise<Preset>((resolve) => { resolveUpdate = resolve })
    let updateCalls = 0
    let response: Preset | null = null
    const adapter: PresetSaveAdapter = {
      async update(presetId, input) {
        updateCalls += 1
        const reorderedMetadata = Object.fromEntries(Object.entries(input.metadata ?? {}).reverse())
        response = {
          ...rawPreset(reorderedMetadata, 3),
          id: presetId,
          name: input.name ?? '',
          parameters: structuredClone(input.parameters ?? {}),
          prompt_order: structuredClone(input.prompt_order ?? []),
          prompts: structuredClone(input.prompts ?? {}),
        }
        return updateGate
      },
    }
    const coordinator = createPresetSaveCoordinator(adapter)
    const base = unmarshalPreset(rawPreset({
      promptVariables: { orphan: 'pruned before persistence' },
    }, 2))
    const unsubscribe = coordinator.subscribe(base.id, () => {})
    expect(base.cacheRevision).toBe(2)
    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, description: 'Updated description' }),
      { immediate: true },
    )
    const flush = coordinator.flush(base.id)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(updateCalls).toBe(1)
    expect(response).not.toBeNull()
    coordinator.hydrate(unmarshalPreset(response!))
    expect(updateCalls).toBe(1)
    expect(coordinator.getDraft(base.id)?.cacheRevision).toBe(3)

    const partialResponse = { ...response! }
    delete partialResponse.cache_revision
    resolveUpdate(partialResponse)
    const saved = await flush
    expect(updateCalls).toBe(1)
    expect(saved.cacheRevision).toBe(3)
    expect(coordinator.getDraft(base.id)?.cacheRevision).toBe(3)
    unsubscribe()
  })
  test('preserves omitted first-class fields in a partial update response', async () => {
    const baseSource = {
      type: 'import',
      slug: 'source-slug',
      importedVersion: 'v1',
      importedName: 'Imported preset',
      importedAt: 10,
    }
    const baseRaw: Preset = {
      ...rawPreset({
        source: baseSource,
        modelProfiles: { primary: { model: 'one' } },
        schemaVersion: 9,
        description: 'Original description',
        coverUrl: 'original-cover',
        isDefault: true,
        lastProfileKey: 'primary',
        promptVariables: { block: { tone: 'warm' } },
        _lumiverse_preset_version: 'v1',
        _lumiverse_provenance: { hub: 'source-hub' },
        extension: { enabled: true },
      }, 7),
      parameters: {
        samplerOverrides: { temperature: 0.7 },
        customBody: { prefix: 'prefix' },
      },
      prompts: {
        promptBehavior: { mode: 'custom' },
        completionSettings: { mode: 'complete' },
        advancedSettings: { mode: 'advanced' },
      },
    }
    const adapter: PresetSaveAdapter = {
      async update(_presetId, input) {
        return rawPreset({
          description: input.metadata?.description ?? '',
        })
      },
    }
    const coordinator = createPresetSaveCoordinator(adapter)
    const unsubscribe = coordinator.subscribe(baseRaw.id, () => {})
    const base = unmarshalPreset(baseRaw)
    coordinator.hydrate(base)
    coordinator.mutate(
      base.id,
      base,
      (preset) => ({ ...preset, description: 'Updated description' }),
      { immediate: true },
    )

    const saved = await coordinator.flush(base.id)

    expect(saved?.description).toBe('Updated description')
    expect(saved?.source).toEqual(baseSource)
    expect(saved?.modelProfiles).toEqual({ primary: { model: 'one' } })
    expect(saved?.schemaVersion).toBe(9)
    expect(saved?.coverUrl).toBe('original-cover')
    expect(saved?.isDefault).toBe(true)
    expect(saved?.lastProfileKey).toBe('primary')
    expect(saved?.promptVariables).toEqual({ block: { tone: 'warm' } })
    expect(saved?.presetVersion).toBe('v1')
    expect(saved?.lumihubMeta).toEqual({ _lumiverse_provenance: { hub: 'source-hub' } })
    expect(saved?.passthroughMetadata).toEqual({ extension: { enabled: true } })
    expect(saved?.samplerOverrides).toEqual(base.samplerOverrides)
    expect(saved?.customBody).toEqual(base.customBody)
    expect(saved?.promptBehavior).toEqual(base.promptBehavior)
    expect(saved?.completionSettings).toEqual(base.completionSettings)
    expect(saved?.advancedSettings).toEqual(base.advancedSettings)
    expect(saved?.cacheRevision).toBe(7)
    unsubscribe()
  })
})
