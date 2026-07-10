import { describe, expect, test } from 'bun:test'
import { createNewLoomPreset, marshalUpdate } from '@/lib/loom/service'
import { applyPresetEditorDraft, toPresetEditorDraft } from './preset-editor-adapter'

describe('preset editor draft adapter', () => {
  test('applies extension metadata while retaining native preset fields', () => {
    const current = createNewLoomPreset('Original', 'Native description')
    const draft = toPresetEditorDraft(current)
    draft.metadata.agentic_preset_composer = { mode: 'multi' }
    draft.blocks[0].content = 'Updated by extension'

    const next = applyPresetEditorDraft(current, draft)
    const raw = marshalUpdate(next)
    expect(next.description).toBe('Native description')
    expect(next.blocks[0].content).toBe('Updated by extension')
    expect(raw.metadata?.agentic_preset_composer).toEqual({ mode: 'multi' })
  })

  test('rejects changing the draft identity', () => {
    const current = createNewLoomPreset('Original')
    const draft = toPresetEditorDraft(current)
    draft.id = 'different'
    expect(() => applyPresetEditorDraft(current, draft)).toThrow('id cannot be changed')
  })
})
