import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./WorldBookEntriesSection.tsx', import.meta.url)).text()

describe('regular lorebook panel smart-search contract', () => {
  test('keeps ordinary navigation paginated and loads the complete corpus only on demand', () => {
    expect(source).toContain('shouldLoadFullWorldBookEntryCorpus(')
    expect(source).toContain('worldBooksApi.listEntries(bookId')
    expect(source).toContain('worldBooksApi.listAllEntries(bookId, { signal: controller.signal })')
    expect(source).toContain('entriesAbortRef.current?.abort()')
    expect(source).toContain("value === 'all' || fullCorpusMode ? count : '—'")
    expect(source).toContain('searchEntriesByQuery(entries, entrySearchFilter, entrySearchIndex)')
    expect(source).toContain('entrySearchResults?.map((result) => result.entry) ?? orderedEntries')
    expect(source).not.toContain('search: search || undefined')
  })

  test('counts query results before applying the selected type', () => {
    expect(source).toContain('for (const entry of queryEntries) counts[getEntryType(entry)] += 1')
    expect(source).toMatch(/entryTypeFilter === 'all'[\s\S]*\? queryEntries[\s\S]*queryEntries\.filter/)
    expect(source).toContain('fullCorpusMode ? filteredEntries.length : sourceEntryTotal')
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
