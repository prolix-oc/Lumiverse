import { describe, expect, test } from 'bun:test'
import type { Preset } from '@/types/api'
import { createNewLoomPreset, marshalPreset } from './service'
import { InvalidLoomPresetError, unmarshalPresetForEditor } from './preset-validation'

function preset(): Preset {
  return { ...marshalPreset(createNewLoomPreset('Working')), id: 'working', created_at: 1, updated_at: 1 } as Preset
}

describe('Loom editor preset validation', () => {
  test.each([
    ['non-array prompt order', (row: Preset) => { row.prompt_order = {} as any }],
    ['null block', (row: Preset) => { row.prompt_order = [null] }],
    ['primitive block', (row: Preset) => { row.prompt_order = ['bad'] }],
    ['non-string content', (row: Preset) => { (row.prompt_order[0] as any).content = {} }],
    ['unexpected block field rejected by the editor bridge', (row: Preset) => { (row.prompt_order[0] as any).extensionPayload = {} }],
    ['prototype property as a block role', (row: Preset) => { (row.prompt_order[0] as any).role = '__proto__' }],
    ['invalid block position', (row: Preset) => { (row.prompt_order[0] as any).position = 'elsewhere' }],
    ['non-string description', (row: Preset) => { row.metadata.description = {} }],
    ['non-array stop strings', (row: Preset) => { (row.prompts.advancedSettings as any).customStopStrings = {} }],
    ['non-string stop string', (row: Preset) => { (row.prompts.advancedSettings as any).customStopStrings = [{}] }],
    ['non-array variables', (row: Preset) => { (row.prompt_order[0] as any).variables = {} }],
    ['null variable', (row: Preset) => { (row.prompt_order[0] as any).variables = [null] }],
    ['malformed options on a text variable', (row: Preset) => { (row.prompt_order[0] as any).variables = [{ id: 'v', name: 'v', label: 'V', type: 'text', defaultValue: '', options: null }] }],
    ['unexpected variable field rejected by the editor bridge', (row: Preset) => { (row.prompt_order[0] as any).variables = [{ id: 'v', name: 'v', label: 'V', type: 'text', defaultValue: '', extra: {} }] }],
    ['missing select options', (row: Preset) => { (row.prompt_order[0] as any).variables = [{ id: 'v', name: 'v', label: 'V', type: 'select', defaultValue: '' }] }],
    ['null select option', (row: Preset) => { (row.prompt_order[0] as any).variables = [{ id: 'v', name: 'v', label: 'V', type: 'select', defaultValue: '', options: [null] }] }],
  ])('rejects %s before rendering', (_name, corrupt) => {
    const row = preset()
    corrupt(row)
    expect(() => unmarshalPresetForEditor(row)).toThrow(InvalidLoomPresetError)
  })

  test('allows migrated defaults, empty presets, legacy duplicate identities, and extension metadata', () => {
    const row = preset()
    row.parameters = {}
    row.prompts = {}
    row.metadata = { extension: { arbitrary: [null, {}] } }
    row.prompt_order.push(structuredClone(row.prompt_order[0]))
    expect(unmarshalPresetForEditor(row).blocks).toHaveLength(3)
    expect(unmarshalPresetForEditor(row).passthroughMetadata).toEqual(row.metadata)
    row.prompt_order = []
    expect(unmarshalPresetForEditor(row).blocks).toEqual([])
  })
})
