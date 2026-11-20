import { describe, expect, test } from 'bun:test'

const workspace = await Bun.file(new URL('./LorebookEditorWorkspace.tsx', import.meta.url)).text()
const toolbar = await Bun.file(new URL('./EntriesToolbar.tsx', import.meta.url)).text()
const table = await Bun.file(new URL('./EntryTable.tsx', import.meta.url)).text()

describe('enhanced lorebook smart-search UI contract', () => {
  test('ranks the complete book before applying the trigger-type filter', () => {
    expect(workspace).toContain('searchEntriesByQuery(entries, entrySearch, entrySearchIndex)')
    expect(workspace).toContain('entrySearchResults?.map((result) => result.entry) ?? entries')
    expect(workspace).toMatch(/typeFilter === 'all'[\s\S]*\? queryEntries[\s\S]*queryEntries\.filter/)
    expect(workspace).toMatch(/constant: queryEntries\.filter[\s\S]*keyword: queryEntries\.filter[\s\S]*vector: queryEntries\.filter/)
  })

  test('cancels a stale complete-book walk when navigation changes', () => {
    expect(workspace).toContain('entriesAbortRef.current?.abort()')
    expect(workspace).toContain('listAllEntries(bookId, { signal: controller.signal })')
    expect(workspace).toContain('if (!controller.signal.aborted) throw error')
  })

  test('clears search and type state when a different book is selected', () => {
    expect(workspace).toMatch(/setSavedAt\(null\)[\s\S]*setEntrySearch\(''\)[\s\S]*setTypeFilter\('all'\)[\s\S]*\[selectedBookId\]/)
  })

  test('owns Ctrl/Cmd+F only inside the workspace and exposes clearable search status', () => {
    expect(workspace).toContain('onKeyDownCapture={handleWorkspaceKeyDown}')
    expect(workspace).toContain("event.key.toLowerCase() !== 'f'")
    expect(workspace).toContain('entrySearchInputRef.current?.focus()')
    expect(toolbar).toContain('type="search"')
    expect(toolbar).toContain('aria-label="Search lorebook entries"')
    expect(toolbar).toContain("event.key !== 'Escape'")
    expect(toolbar).toContain('aria-live="polite"')
    expect(toolbar).toContain('aria-label="Clear entry search"')
  })

  test('renders structured matches as React text and remeasures snippet rows', () => {
    expect(table).toContain('<HighlightedText')
    expect(table).toContain('<mark')
    expect(table).not.toContain('dangerouslySetInnerHTML')
    expect(table).toContain('searchResult?.snippet')
    expect(table).toMatch(/virtualizer\.measure\(\)[\s\S]*\[searchResultsById, virtualizer\]/)
    expect(table).toContain('Clear search')
    expect(table).toContain('Show all types')
  })
})
