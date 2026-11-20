import { describe, expect, spyOn, test } from 'bun:test'
import * as uuid from '@/lib/uuid'
import {
  coerceImportedLoomPreset,
  computeGroups,
  createPortableLoomPresetExport,
  exportToSTPreset,
  importFromSTPreset,
  marshalPreset,
  marshalUpdate,
  unmarshalPreset,
} from './service'

describe('SillyTavern preset import', () => {
  test('keeps ST identifiers as block ids so prompts stay addressable', () => {
    const preset = importFromSTPreset({
      prompts: [
        { identifier: 'main', name: 'Main', content: 'Main prompt' },
        { identifier: '1488ea1c-4059-46b8-9a10-9676925d7723', name: 'Header', content: '' },
        { identifier: 'prompt_1788337669850_g9jvkyl', name: 'Custom', content: 'Custom text' },
        { identifier: 'unordered', name: 'Leftover', content: 'Not in order' },
      ],
      prompt_order: {
        100001: {
          order: [
            { identifier: 'main', enabled: true },
            { identifier: '1488ea1c-4059-46b8-9a10-9676925d7723', enabled: true },
            { identifier: 'prompt_1788337669850_g9jvkyl', enabled: false },
          ],
        },
      },
    }, 'Ids')

    const byName = (name: string) => preset.blocks.find((block) => block.name === name)!
    expect(byName('Header').id).toBe('1488ea1c-4059-46b8-9a10-9676925d7723')
    expect(byName('Custom').id).toBe('prompt_1788337669850_g9jvkyl')
    expect(byName('Leftover').id).toBe('unordered')
    // Markers keep generated ids; export maps them back to their ST identifiers.
    expect(byName('Main').marker).toBe('main_prompt')
    expect(byName('Main').id).not.toBe('main')
    expect(new Set(preset.blocks.map((block) => block.id)).size).toBe(preset.blocks.length)
  })

  test('ST identifiers survive an export and re-import round trip', () => {
    const first = importFromSTPreset({
      prompts: [
        { identifier: 'main', name: 'Main', content: 'Main prompt' },
        { identifier: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Rule', content: 'Be kind.' },
      ],
      prompt_order: { 100001: { order: [{ identifier: 'main', enabled: true }, { identifier: 'a1b2c3d4-0000-4000-8000-000000000001', enabled: true }] } },
    }, 'Round trip')
    const exported = exportToSTPreset(first)
    expect(exported.prompts.map((prompt: { identifier: string }) => prompt.identifier)).toContain('a1b2c3d4-0000-4000-8000-000000000001')
    const second = importFromSTPreset(exported, 'Round trip again')
    expect(second.blocks.find((block) => block.name === 'Rule')!.id).toBe('a1b2c3d4-0000-4000-8000-000000000001')
  })

  test('falls back to generated ids for missing or repeated ST identifiers', () => {
    const preset = importFromSTPreset({
      prompts: [
        { identifier: 'dup', name: 'First', content: 'a' },
        { identifier: 'dup', name: 'Second', content: 'b' },
        { name: 'No id', content: 'c' },
      ],
      prompt_order: { 100001: { order: [{ identifier: 'dup', enabled: true }] } },
    }, 'Fallback')

    const ids = preset.blocks.map((block) => block.id)
    expect(preset.blocks.filter((block) => !block.marker).map((block) => block.content)).toEqual(['b', 'a', 'c'])
    expect(ids).toContain('dup')
    expect(new Set(ids).size).toBe(ids.length)
    expect(preset.blocks.find((block) => block.name === 'No id')!.id).not.toBe('')
  })

  test('retains every definition with repeated identifiers without repeating ordered entries', () => {
    const prompts = [
      { identifier: 'dup', name: 'First', content: 'a' },
      { identifier: 'dup', name: 'Second', content: 'b' },
    ]
    for (const prompt_order of [undefined, { 100001: { order: [{ identifier: 'dup' }, { identifier: 'dup' }] } }]) {
      const preset = importFromSTPreset({ prompts, prompt_order }, 'Duplicates')
      const ordinary = preset.blocks.filter((block) => !block.marker)
      expect(ordinary).toHaveLength(2)
      expect(ordinary.map((block) => block.content).sort()).toEqual(['a', 'b'])
      expect(new Set(preset.blocks.map((block) => block.id)).size).toBe(preset.blocks.length)
    }
  })

  test('preserves exact nonblank identifiers and their extension references', () => {
    const ids = [' padded ', 'padded']
    const preset = importFromSTPreset({
      prompts: ids.map((identifier) => ({ identifier, name: identifier, content: `Content for ${identifier}` })),
      extensions: { toolkit: { ids } },
    }, 'Exact identities')
    for (const id of ids) {
      expect(preset.blocks.find((block) => block.id === id)).toMatchObject({ marker: null, content: `Content for ${id}` })
    }
    expect(preset.passthroughMetadata.toolkit).toEqual({ ids })
    const reimported = importFromSTPreset(exportToSTPreset(preset), 'Again')
    expect(reimported.blocks.filter((block) => !block.marker).map((block) => block.id)).toEqual(ids)
  })

  test('preserves content under prototype-like identifiers with safe generated ids', () => {
    const ids = Object.getOwnPropertyNames(Object.prototype)
    const preset = importFromSTPreset({
      prompts: ids.map((identifier) => ({ identifier, name: identifier, content: `Content for ${identifier}` })),
    }, 'Reserved keys')
    for (const name of ids) {
      const block = preset.blocks.find((block) => block.name === name)!
      expect(block).toMatchObject({ marker: null, content: `Content for ${name}` })
      expect(Object.hasOwn(Object.prototype, block.id)).toBe(false)
    }
    expect(new Set(preset.blocks.map((block) => block.id)).size).toBe(preset.blocks.length)
  })

  test('generated marker and fallback ids cannot consume preserved prompt identifiers', () => {
    const reserved = '00000000-0000-4000-8000-000000000001'
    const fallback = '00000000-0000-4000-8000-000000000002'
    let next = 0
    const candidates = [reserved, reserved, 'generated', 'generated', 'generated', reserved]
    const generator = spyOn(uuid, 'generateUUID').mockImplementation(() => (
      candidates[next++] ?? `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`
    ))
    try {
      const preset = importFromSTPreset({ prompts: [
        { identifier: 'main', name: 'Main', content: 'Main' },
        { name: 'Missing', content: 'Fallback' },
        { identifier: reserved, name: 'Preserved', content: 'Original' },
        { identifier: fallback, name: 'Other', content: 'Other' },
        { identifier: '   ', name: 'Blank', content: 'Blank' },
      ] }, 'Collisions')
      expect(preset.blocks.find((block) => block.name === 'Preserved')!.id).toBe(reserved)
      expect(preset.blocks.find((block) => block.name === 'Other')!.id).toBe(fallback)
      expect(preset.blocks.find((block) => block.name === 'Blank')!.id.trim()).not.toBe('')
      expect(new Set(preset.blocks.map((block) => block.id)).size).toBe(preset.blocks.length)
    } finally {
      generator.mockRestore()
    }
  })

  test('keeps prompts grouped under sequential ━ category headings', () => {
    const preset = importFromSTPreset({
      prompts: [
        { identifier: 'category-one', name: '━━━━ OOC ━━━', content: '' },
        { identifier: 'ooc-tone', name: 'Tone', content: 'Write vividly.' },
        { identifier: 'ooc-style', name: 'Style', content: 'Use prose.' },
        { identifier: 'category-two', name: '━━━━ Optional', content: '' },
        { identifier: 'optional-detail', name: 'Detailing', content: 'Be specific.' },
      ],
      prompt_order: {
        100001: {
          order: [
            { identifier: 'category-one', enabled: true },
            { identifier: 'ooc-tone', enabled: true },
            { identifier: 'ooc-style', enabled: false },
            { identifier: 'category-two', enabled: true },
            { identifier: 'optional-detail', enabled: true },
          ],
        },
      },
    }, 'Celia')

    const categoryOne = preset.blocks.find((block) => block.name === '━━━━ OOC ━━━')!
    const categoryTwo = preset.blocks.find((block) => block.name === '━━━━ Optional')!
    const tone = preset.blocks.find((block) => block.name === 'Tone')!
    const style = preset.blocks.find((block) => block.name === 'Style')!
    const detail = preset.blocks.find((block) => block.name === 'Detailing')!

    expect(categoryOne.marker).toBe('category')
    expect(categoryTwo.marker).toBe('category')
    expect([tone.group, style.group]).toEqual([categoryOne.id, categoryOne.id])
    expect(detail.group).toBe(categoryTwo.id)
    expect(computeGroups(preset.blocks).map((group) => ({
      category: group.categoryBlock?.name,
      children: group.children.map((block) => block.name),
    }))).toEqual(expect.arrayContaining([
      { category: '━━━━ OOC ━━━', children: ['Tone', 'Style'] },
      { category: '━━━━ Optional', children: ['Detailing', 'Chat History'] },
    ]))
  })

  test('keeps extension data such as JS-Slash-Runner scripts as passthrough metadata', () => {
    const tavernHelper = {
      scripts: [{ type: 'script', enabled: true, name: 'Panel', id: 'script-1', content: 'console.log(1)', info: '', button: { enabled: true, buttons: [{ name: 'Open', visible: true }] }, data: {} }],
      variables: {},
    }
    const toolkit = { presetPromptGroups: [{ name: 'Mode', ids: ['ooc-tone'] }] }
    const preset = importFromSTPreset({
      prompts: [{ identifier: 'ooc-tone', name: 'Tone', content: 'Write vividly.' }],
      extensions: {
        regex_scripts: [{ scriptName: 'Hide', findRegex: '<x>', replaceString: '' }],
        tavern_helper: tavernHelper,
        otherToolkit: toolkit,
        source: { type: 'spoofed' },
        _lumiverse_install_source: 'lumihub',
      },
    }, 'Scripted')

    expect(preset.passthroughMetadata).toEqual({ tavern_helper: tavernHelper, otherToolkit: toolkit })
    expect(preset.source?.type).toBe('st_import')
    expect(preset.lumihubMeta).toBeNull()

    const metadata = marshalPreset(preset).metadata as Record<string, unknown>
    expect(metadata.tavern_helper).toEqual(tavernHelper)
    expect(metadata.otherToolkit).toEqual(toolkit)
    expect(metadata).not.toHaveProperty('regex_scripts')
    expect((metadata.source as { type?: string }).type).toBe('st_import')
  })

  test('imports presets without extensions with empty passthrough metadata', () => {
    const preset = importFromSTPreset({
      prompts: [{ identifier: 'ooc-tone', name: 'Tone', content: 'Write vividly.' }],
    }, 'Plain')
    expect(preset.passthroughMetadata).toEqual({})
    const malformed = importFromSTPreset({
      prompts: [{ identifier: 'ooc-tone', name: 'Tone', content: 'Write vividly.' }],
      extensions: ['not', 'a', 'record'] as unknown as Record<string, unknown>,
    }, 'Malformed')
    expect(malformed.passthroughMetadata).toEqual({})
  })

  test('round-trips prototype-like extension keys as own data properties', () => {
    const extensions = JSON.parse('{"__proto__":{"inherited":"extension data"},"constructor":{"scripts":[]},"ordinary":null}')
    const imported = importFromSTPreset({ prompts: [], extensions }, 'Special keys')
    const input = marshalPreset(imported)
    const saved = unmarshalPreset({
      ...input,
      id: imported.id,
      parameters: input.parameters ?? {},
      prompt_order: input.prompt_order ?? [],
      prompts: input.prompts ?? {},
      metadata: input.metadata ?? {},
      created_at: 1,
      updated_at: 1,
    })
    const exported = JSON.parse(JSON.stringify(createPortableLoomPresetExport(saved)))
    const reimported = coerceImportedLoomPreset(exported, 'Round trip')

    for (const preset of [imported, saved, reimported]) {
      expect(Object.getPrototypeOf(preset.passthroughMetadata)).toBe(Object.prototype)
      expect(Object.hasOwn(preset.passthroughMetadata, '__proto__')).toBe(true)
      expect(preset.passthroughMetadata.inherited).toBeUndefined()
      expect(preset.passthroughMetadata).toEqual(extensions)
      const metadata = JSON.parse(JSON.stringify(marshalUpdate(preset).metadata))
      expect(Object.hasOwn(metadata, '__proto__')).toBe(true)
      expect(metadata.__proto__).toEqual(extensions.__proto__)
      expect(metadata.constructor).toEqual(extensions.constructor)
    }
  })
})
