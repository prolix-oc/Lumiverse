import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./WorldBookEntriesSection.tsx', import.meta.url)).text()

describe('regular lorebook panel smart-search contract', () => {
  test('loads the complete organization/type scope for ranked search', () => {
    expect(source).toContain('loadLorebookSearchEntries(pagination => worldBooksApi.listEntries(bookId')
    expect(source).toContain('folder: entryFolder')
    expect(source).toContain('tag: entryTags')
    expect(source).not.toContain('search: entrySearchFilter')
    expect(source).toContain("type: entryTypeFilter === 'all' ? undefined : entryTypeFilter")
    expect(source).toContain('entriesAbortRef.current?.abort()')
    expect(source).toContain('controller.signal.aborted || entriesAbortRef.current !== controller')
  })

  test('uses ranked results before slicing a visible search page', () => {
    expect(source).toContain('searchEntriesByQuery(entries, entrySearchFilter, entrySearchIndex)')
    expect(source).toContain('entrySearchResults?.map((result) => result.entry) ?? entries')
    expect(source).toContain('queryEntries.slice((entryPage - 1) * pageSize, entryPage * pageSize)')
    expect(source).toContain('searchCorpusMode ? queryEntries.length : sourceEntryTotal')
    expect(source).toContain('loadedSearchScopeRef.current === searchScope')
  })

  test('keeps search clearable, scoped, and independent from the open entry', () => {
    expect(source).toContain('entrySearchInputRef.current?.focus()')
    expect(source).toContain('event.key.toLowerCase() !== \'f\'')
    expect(source).toContain('type="search"')
    expect(source).toContain('clearSearchOnEscape')
    expect(source).toContain('Open entry kept visible while filters are active')
    expect(source).not.toMatch(/onChange=\{\(e\) => \{[\s\S]{0,180}setSelectedEntryId\(null\)/)
  })

  test('renders safe structured highlights and hidden-field context', () => {
    expect(source).toContain('<HighlightedEntryText')
    expect(source).toContain('searchResult?.snippet')
    expect(source).toContain('entrySearchResultsById.get(entry.id)')
    expect(source).not.toContain('dangerouslySetInnerHTML')
  })

  test('resets query and type when the selected lorebook changes', () => {
    expect(source).toContain('setEntrySearchFilter(reset.entrySearchFilter)')
    expect(source).toContain('setEntryTypeFilter(reset.entryTypeFilter)')
  })

  test('refreshes server pagination metadata after live deletions', () => {
    expect(source).toContain('A server-paginated view does not hold enough rows')
    expect(source).toContain('scheduleLiveRefetch()')
  })
})
