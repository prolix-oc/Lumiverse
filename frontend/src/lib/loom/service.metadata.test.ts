import { describe, expect, test } from 'bun:test'
import type { Preset } from '@/types/api'
import {
  coerceImportedLoomPreset,
  marshalPreset,
  marshalUpdate,
  unmarshalPreset,
} from './service'

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
  test('defaults trim-incomplete-words to off for existing presets', () => {
    expect(unmarshalPreset(rawPreset({})).advancedSettings.trimIncompleteWords).toBe(false)
  })

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

})
