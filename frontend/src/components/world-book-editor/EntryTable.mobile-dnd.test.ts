import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./EntryTable.tsx', import.meta.url)).text()
const styles = await Bun.file(new URL('./LorebookEditorLayout.module.css', import.meta.url)).text()

describe('EntryTable mobile drag contract', () => {
  test('uses dedicated mouse and delayed touch sensors', () => {
    expect(source).toContain('MouseSensor')
    expect(source).toContain('TouchSensor')
    expect(source).toContain('delay: 180')
    expect(source).toContain('tolerance: 6')
    expect(source).not.toContain('PointerSensor')
  })

  test('reserves touch gestures only on the drag handle', () => {
    const handleRule = styles.match(/\.entryDragHandle\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(handleRule).toContain('touch-action: none')
  })
})
