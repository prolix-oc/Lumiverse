import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./LorebookEditorWorkspace.tsx', import.meta.url)).text()

describe('LorebookEditorWorkspace delete selection contract', () => {
  test('clears selectedIds only after a successful delete', () => {
    const start = source.indexOf('const deleteSelected = useCallback(')
    const end = source.indexOf('\n  const toggleEntrySelection', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const body = source.slice(start, end)
    expect(body).toContain("const deleted = await runBulk({ action: 'delete', entry_ids: selectedIds })")
    expect(body).toContain('if (deleted) setSelectedIds([])')
    expect(body).not.toMatch(/await runBulk\(\{ action: 'delete'[\s\S]*\n\s*setSelectedIds\(\[\]\)/)
  })
})
