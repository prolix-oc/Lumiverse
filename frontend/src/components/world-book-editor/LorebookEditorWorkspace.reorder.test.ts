import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./LorebookEditorWorkspace.tsx', import.meta.url)).text()

describe('LorebookEditorWorkspace reorder selection contract', () => {
  test('drops late reorder completion after the selected book changes', () => {
    expect(source).toContain('const reorderBookId = selectedBookId')
    expect(source).toContain('worldBooksApi.reorderEntries(reorderBookId')
    expect(source).toContain('runLorebookReorderIfCurrent({')
    expect(source).toContain('getCurrentBookId: () => selectedBookIdRef.current')
    expect(source).toContain('refresh: () => loadEntries(reorderBookId)')
    expect(source).toMatch(/setSavedAt\(null\)[\s\S]*\[selectedBookId\]/)
    expect(source).not.toContain('worldBooksApi.reorderEntries(selectedBookId')
    expect(source).not.toMatch(
      /worldBooksApi\.reorderEntries\(selectedBookId[\s\S]*loadEntries\(selectedBookId\)/,
    )
    const reorderStart = source.indexOf('const reorderEntries = useCallback(')
    const nextHandlerStart = source.indexOf('\n  const saveEntry =', reorderStart)
    expect(reorderStart).toBeGreaterThanOrEqual(0)
    expect(nextHandlerStart).toBeGreaterThan(reorderStart)
    expect(source.slice(reorderStart, nextHandlerStart)).not.toContain(
      'loadEntries(selectedBookId)\n      setSavedAt',
    )
  })
})
