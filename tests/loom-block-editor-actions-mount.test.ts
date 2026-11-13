/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const loomBuilderPath = resolve(import.meta.dir, '../frontend/src/components/panels/LoomBuilder.tsx')

describe('Loom block editor action mount', () => {
  test('adds a dedicated BlockEditor header socket without repurposing existing Loom mounts', async () => {
    const source = await Bun.file(loomBuilderPath).text()
    const blockEditorStart = source.indexOf('export function BlockEditor(')
    const blockEditorEnd = source.indexOf('export interface ControlledLoomBlockEditorProps')

    expect(blockEditorStart).toBeGreaterThanOrEqual(0)
    expect(blockEditorEnd).toBeGreaterThan(blockEditorStart)

    const blockEditorSource = source.slice(blockEditorStart, blockEditorEnd)
    expect(blockEditorSource.match(/data-spindle-mount="loom_block_editor_actions"/g)).toHaveLength(2)
    expect(blockEditorSource).toContain('data-spindle-scope={`loom-block:${block.id}:editor-actions`}')
    expect(blockEditorSource).not.toContain('data-spindle-mount="loom_builder_toolbar"')

    expect(source.match(/data-spindle-mount="loom_builder_toolbar"/g)).toHaveLength(2)
    expect(source.match(/data-spindle-mount="preset_editor_toolbar"/g)).toHaveLength(2)
    expect(source.match(/data-spindle-mount="loom_builder_inspector"/g)).toHaveLength(1)
  })
})
