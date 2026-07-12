import { describe, expect, test } from 'bun:test'
import type { Preset } from '@/types/api'
import {
  coerceImportedLoomPreset,
  marshalPreset,
  marshalUpdate,
  unmarshalPreset,
} from './service'
import { SPINDLE_EXTENSION_METADATA_KEY } from './service'

function rawPreset(metadata: Record<string, unknown>): Preset {
  return {
    id: 'preset-1',
    name: 'Metadata test',
    provider: 'loom',
    parameters: {},
    prompt_order: [],
    prompts: {},
    metadata,
    created_at: 1,
    updated_at: 2,
  }
}

describe('Loom extension metadata preservation', () => {
  test('round-trips unknown namespaced metadata without allowing it to override core fields', () => {
    const loom = unmarshalPreset(rawPreset({
      description: 'Core description',
      agentic_preset_composer: { mode: 'parallel', threads: ['a', 'b'] },
      _lumiverse_lumihub_id: 'hub-1',
    }))

    expect(loom.passthroughMetadata.agentic_preset_composer).toEqual({
      mode: 'parallel',
      threads: ['a', 'b'],
    })

    loom.passthroughMetadata.description = 'Attempted override'
    const metadata = marshalUpdate(loom).metadata!
    expect(metadata.description).toBe('Core description')
    expect(metadata.agentic_preset_composer).toEqual({ mode: 'parallel', threads: ['a', 'b'] })
    expect(metadata._lumiverse_lumihub_id).toBe('hub-1')
  })

  test('survives the internal export/import shape', () => {
    const loom = unmarshalPreset(rawPreset({
      agentic_preset_composer: { version: 1, pipelines: [{ id: 'main' }] },
    }))
    const exported = JSON.parse(JSON.stringify(loom))
    const imported = coerceImportedLoomPreset(exported, 'Fallback')
    expect(marshalPreset(imported).metadata?.agentic_preset_composer).toEqual({
      version: 1,
      pipelines: [{ id: 'main' }],
    })
  })

  test('preserves colliding extension namespaces in the protected Spindle envelope', () => {
    const nativeSource = {
      type: 'native-source',
      slug: null,
      importedVersion: null,
      importedName: null,
      importedAt: 1,
    }
    const loom = unmarshalPreset(rawPreset({
      source: nativeSource,
      description: 'Native description',
      [SPINDLE_EXTENSION_METADATA_KEY]: {
        source: { mode: 'parallel' },
        description: { mode: 'single' },
      },
    }))

    expect(loom.source).toEqual(nativeSource)
    expect(loom.description).toBe('Native description')
    expect(loom.passthroughMetadata[SPINDLE_EXTENSION_METADATA_KEY]).toEqual({
      source: { mode: 'parallel' },
      description: { mode: 'single' },
    })

    const metadata = marshalUpdate(loom).metadata!
    expect(metadata.source).toEqual(nativeSource)
    expect(metadata.description).toBe('Native description')
    expect(metadata[SPINDLE_EXTENSION_METADATA_KEY]).toEqual({
      source: { mode: 'parallel' },
      description: { mode: 'single' },
    })
  })
})
