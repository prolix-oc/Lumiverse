import { describe, expect, test } from 'bun:test'
import { ADDABLE_MARKERS, MARKER_NAMES, STRUCTURAL_MARKERS } from './constants'
import { createMarkerBlock, createNewLoomPreset, exportToSTPreset, importFromSTPreset, marshalPreset, unmarshalPreset } from './service'

describe('character instruction markers', () => {
  test.each([
    ['system_prompt', 'Character System Prompt', 'pre_history'],
    ['post_history_instructions', 'Character Post-History Instructions', 'post_history'],
  ])('%s is addable, locked, and preserved by preset serialization', (marker, name, position) => {
    expect(ADDABLE_MARKERS).toContain(marker)
    expect(STRUCTURAL_MARKERS.has(marker)).toBe(true)
    expect(MARKER_NAMES[marker]).toBe(name)
    const block = createMarkerBlock(marker)
    expect(block).toMatchObject({ marker, name, content: '', enabled: true, isLocked: true, position })
    const preset = createNewLoomPreset('Instructions')
    preset.blocks.push(block)
    const marshalled = marshalPreset(preset)
    const restored = unmarshalPreset({ ...marshalled, id: preset.id, created_at: 0, updated_at: 0 } as Parameters<typeof unmarshalPreset>[0])
    expect(restored.blocks.find(row => row.id === block.id)).toMatchObject(block)
  })

  test.each(['system_prompt', 'post_history_instructions'])('%s survives legacy export with placement and opt-outs', marker => {
    const preset = createNewLoomPreset('Legacy instructions')
    const block = {
      ...createMarkerBlock(marker), role: 'assistant' as const, position: 'in_history' as const, depth: 2,
      enabled: false, injectionTrigger: ['continue'], characterTagTrigger: ['fantasy'],
    }
    preset.blocks.push(block)
    const exported = exportToSTPreset(preset)
    const prompt = exported.prompts.find((row: { identifier: string }) => row.identifier === block.id)
    expect(prompt.content).toBe(marker === 'system_prompt' ? '{{charPrompt}}' : '{{charInstruction}}')
    const restored = importFromSTPreset(exported, 'Restored')
    expect(restored.blocks.find(row => row.id === block.id)).toMatchObject(block)
  })
})
