import { describe, expect, test } from 'bun:test'
import type { Preset } from '@/types/api'
import {
  coerceImportedLoomPreset,
  createPortableLoomPresetExport,
  exportToSTPreset,
  getRemotePresetOrigin,
  marshalPreset,
  marshalUpdate,
  shouldShowLumiHubPresetBadge,
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
  test('retains Illarin release identity and display label through edits and exports', () => {
    const loom = unmarshalPreset(rawPreset({
      _lumiverse_install_source: 'illarin',
      _lumiverse_illarin_asset_id: 'work-1',
      _lumiverse_illarin_version_number: 4,
      _lumiverse_preset_version: 'stable',
    }))
    expect(loom.presetVersion).toBe('stable')
    expect(marshalUpdate(loom).metadata).toMatchObject({
      _lumiverse_illarin_version_number: 4,
      _lumiverse_preset_version: 'stable',
    })
    const exported = createPortableLoomPresetExport(loom)
    expect(exported.lumihubMeta?._lumiverse_illarin_version_number).toBe(4)
  })
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

  test('keeps a cover URL stored inside a wrapped LumiHub preset', () => {
    const imported = coerceImportedLoomPreset({
      type: 'lumiverse_preset',
      preset: {
        ...unmarshalPreset(rawPreset({})),
        coverUrl: 'https://cdn.example.test/preset-cover.webp',
      },
    }, 'Fallback')

    expect(imported.coverUrl).toBe('https://cdn.example.test/preset-cover.webp')
    expect(marshalPreset(imported).metadata?.coverUrl).toBe('https://cdn.example.test/preset-cover.webp')
  })

  test('prefers an explicit wrapper cover URL over the nested preset value', () => {
    const imported = coerceImportedLoomPreset({
      type: 'lumiverse_preset',
      cover_url: 'https://cdn.example.test/wrapper.webp',
      preset: {
        ...unmarshalPreset(rawPreset({})),
        coverUrl: 'https://cdn.example.test/nested.webp',
      },
    }, 'Fallback')

    expect(imported.coverUrl).toBe('https://cdn.example.test/wrapper.webp')
  })

  test('marks file imports as local even when the export carries LumiHub provenance', () => {
    const imported = coerceImportedLoomPreset({
      ...unmarshalPreset(rawPreset({
        _lumiverse_install_source: 'lumihub',
        _lumiverse_lumihub_id: 'hub-1',
        _lumiverse_preset_version: '2.0.0',
      })),
      blocks: [],
    }, 'Fallback')

    expect(imported.lumihubMeta?._lumiverse_install_source).toBe('local')
    expect(shouldShowLumiHubPresetBadge(imported)).toBe(false)
  })

  test('shows the LumiHub badge for explicit installs and legacy versioned presets only', () => {
    expect(shouldShowLumiHubPresetBadge({
      presetVersion: null,
      lumihubMeta: { _lumiverse_install_source: 'lumihub' },
    })).toBe(true)
    expect(shouldShowLumiHubPresetBadge({ presetVersion: '1.0.0', lumihubMeta: null })).toBe(true)
    expect(shouldShowLumiHubPresetBadge({
      presetVersion: '1.0.0',
      lumihubMeta: { _lumiverse_install_source: 'local' },
    })).toBe(false)
    expect(shouldShowLumiHubPresetBadge({ presetVersion: null, lumihubMeta: null })).toBe(false)
  })

  test('reports Illarin provenance without treating it as a LumiHub install', () => {
    const preset = {
      presetVersion: '2.1.0',
      lumihubMeta: { _lumiverse_install_source: 'illarin' },
    }
    expect(getRemotePresetOrigin(preset)).toBe('illarin')
    expect(shouldShowLumiHubPresetBadge(preset)).toBe(false)
  })

  test('removes the local preset id from portable exports', () => {
    const exported = createPortableLoomPresetExport(unmarshalPreset(rawPreset({})))
    expect(Object.hasOwn(exported, 'id')).toBe(false)
    expect(exported.name).toBe('Metadata test')
  })

  test('redacts materialized Illarin sealed blocks from portable exports', () => {
    const preset = unmarshalPreset({
      ...rawPreset({ _lumiverse_install_source: 'illarin' }),
      prompt_order: [{
        id: 'private-block',
        name: 'Private block',
        content: 'private Illarin content',
        role: 'system',
        enabled: true,
        position: 'pre_history',
        depth: 0,
        marker: null,
        isLocked: false,
        color: null,
        injectionTrigger: [],
        group: null,
        sealed: true,
        sealedKey: 'publisher.instructions',
      }],
    })

    const exported = createPortableLoomPresetExport(preset)
    expect(exported.blocks[0]).toMatchObject({
      content: '{{presetBlock::publisher.instructions}}',
      sealed: true,
      sealedKey: 'publisher.instructions',
      sealedSource: 'illarin',
    })
    expect(JSON.stringify(exported)).not.toContain('private Illarin content')

    const legacyExport = exportToSTPreset(preset)
    expect(JSON.stringify(legacyExport)).toContain('{{presetBlock::publisher.instructions}}')
    expect(JSON.stringify(legacyExport)).not.toContain('private Illarin content')
  })

})
