import { describe, expect, test } from 'bun:test'
import {
  createEntrySearchIndex,
  normalizeEntryQuery,
  parseEntrySearchQuery,
  searchEntriesByQuery,
  type SearchableEntry,
} from './lorebookEntrySearch'

function entry(overrides: Partial<SearchableEntry> = {}): SearchableEntry {
  return {
    comment: '',
    content: '',
    key: [],
    keysecondary: [],
    group_name: '',
    outlet_name: null,
    wi_marker: null,
    ...overrides,
  }
}

describe('lorebook entry smart search', () => {
  test('normalizes case, accents, and whitespace and parses exact phrases', () => {
    expect(normalizeEntryQuery('  CAFÉ\n\tSociety  ')).toBe('cafe society')
    expect(parseEntrySearchQuery('dragon "Old   Harbor" guild')).toEqual([
      { value: 'dragon', phrase: false },
      { value: 'old harbor', phrase: true },
      { value: 'guild', phrase: false },
    ])
    expect(parseEntrySearchQuery('dragon "old harbor')).toEqual([
      { value: 'dragon', phrase: false },
      { value: 'old', phrase: false },
      { value: 'harbor', phrase: false },
    ])
  })

  test('requires every term while allowing terms to match different authored fields', () => {
    const index = createEntrySearchIndex()
    const matching = entry({ comment: 'Moon Harbor', keysecondary: ['silver guild'] })
    const partial = entry({ comment: 'Moon Harbor' })
    const results = searchEntriesByQuery([partial, matching], 'moon guild', index)

    expect(results?.map((result) => result.entry)).toEqual([matching])
    expect(results?.[0].matches.map((match) => match.field)).toContain('comment')
    expect(results?.[0].matches.map((match) => match.field)).toContain('secondaryKey')
  })

  test('searches all core authored fields', () => {
    const index = createEntrySearchIndex()
    const values = [
      entry({ comment: 'title-needle' }),
      entry({ key: ['primary-needle'] }),
      entry({ keysecondary: ['secondary-needle'] }),
      entry({ content: 'content-needle' }),
      entry({ group_name: 'group-needle' }),
      entry({ outlet_name: 'outlet-needle' }),
      entry({ wi_marker: 'marker-needle' }),
    ]

    for (const value of values) {
      const needle = [
        value.comment,
        ...value.key,
        ...(value.keysecondary ?? []),
        value.content,
        value.group_name ?? '',
        value.outlet_name ?? '',
        value.wi_marker ?? '',
      ].find((candidate) => candidate.endsWith('-needle'))!
      expect(searchEntriesByQuery(values, needle, index)?.map((result) => result.entry)).toContain(value)
    }
  })

  test('maps normalized accent matches back to the original source range', () => {
    const index = createEntrySearchIndex()
    const value = entry({ comment: 'The Café Society' })
    const result = searchEntriesByQuery([value], 'CAFE', index)?.[0]
    const match = result?.matches.find((candidate) => candidate.field === 'comment')

    expect(match).toMatchObject({ start: 4, end: 8, fuzzy: false })
    expect(value.comment.slice(match!.start, match!.end)).toBe('Café')
  })

  test('allows bounded typo matches in metadata but never fuzzes content or phrases', () => {
    const index = createEntrySearchIndex()
    const metadata = entry({ comment: 'Dragon Archive' })
    const content = entry({ content: 'Dragon Archive' })

    expect(searchEntriesByQuery([content, metadata], 'dragn', index)?.map((result) => result.entry)).toEqual([metadata])
    expect(searchEntriesByQuery([metadata], 'dgn', index)).toEqual([])
    expect(searchEntriesByQuery([metadata], '"dragn"', index)).toEqual([])
  })

  test('allows two edits only for terms at least eight characters long', () => {
    const index = createEntrySearchIndex()
    const value = entry({ comment: 'Encyclopedia' })
    expect(searchEntriesByQuery([value], 'encyclxpediz', index)?.length).toBe(1)
    expect(searchEntriesByQuery([value], 'encyclxqediz', index)).toEqual([])
  })

  test('normalizes whitespace inside exact phrases without making phrases fuzzy', () => {
    const index = createEntrySearchIndex()
    const value = entry({ content: 'The old\n\n harbor sleeps.' })
    expect(searchEntriesByQuery([value], '"old harbor"', index)?.[0].entry).toBe(value)
    expect(searchEntriesByQuery([value], '"old harbr"', index)).toEqual([])
  })

  test('ranks title and key matches above metadata and content, preserving authored order on ties', () => {
    const index = createEntrySearchIndex()
    const firstContent = entry({ content: 'ember' })
    const secondContent = entry({ content: 'ember' })
    const group = entry({ group_name: 'ember' })
    const key = entry({ key: ['ember'] })
    const title = entry({ comment: 'ember' })

    expect(searchEntriesByQuery([firstContent, group, secondContent, key, title], 'ember', index)?.map((result) => result.entry)).toEqual([
      title,
      key,
      group,
      firstContent,
      secondContent,
    ])
  })

  test('keeps every exact title/key match ahead of metadata and fuzzy metadata ahead of content', () => {
    const index = createEntrySearchIndex()
    const exactGroup = entry({ group_name: 'ember' })
    const exactSecondaryKey = entry({ keysecondary: ['the ember archive'] })
    const exactContent = entry({ content: 'embdr' })
    const fuzzyMarker = entry({ wi_marker: 'ember' })

    expect(searchEntriesByQuery([exactGroup, exactSecondaryKey], 'ember', index)?.map((result) => result.entry))
      .toEqual([exactSecondaryKey, exactGroup])
    expect(searchEntriesByQuery([exactContent, fuzzyMarker], 'embdr', index)?.map((result) => result.entry))
      .toEqual([fuzzyMarker, exactContent])
  })

  test('adds one labeled hidden-field snippet only when visible fields do not explain every clause', () => {
    const index = createEntrySearchIndex()
    const hidden = entry({ comment: 'Moon Harbor', content: 'The silver guild keeps watch by the northern gate.' })
    const visible = entry({ comment: 'Moon Harbor Guild' })
    const results = searchEntriesByQuery([hidden, visible], 'moon guild', index)!
    const hiddenResult = results.find((result) => result.entry === hidden)!
    const visibleResult = results.find((result) => result.entry === visible)!

    expect(hiddenResult.snippet).toMatchObject({ field: 'content', label: 'Content' })
    expect(hiddenResult.snippet?.text).toContain('silver guild')
    expect(hiddenResult.snippet?.ranges).toEqual([{ start: 11, end: 16, fuzzy: false }])
    expect(visibleResult.snippet).toBeNull()
  })

  test('reuses the folded entry across keystrokes and folds immutable replacements once', () => {
    const index = createEntrySearchIndex()
    const original = entry({ comment: 'Dragon', content: 'A'.repeat(50_000) })
    const replacement = { ...original, comment: 'Dragon Gate' }

    expect(searchEntriesByQuery([original], 'drag', index)?.length).toBe(1)
    expect(searchEntriesByQuery([original], 'dragon', index)?.length).toBe(1)
    expect(index.folds()).toBe(1)
    expect(searchEntriesByQuery([replacement], 'gate', index)?.length).toBe(1)
    expect(index.folds()).toBe(2)
  })

  test('invalidates a cached record when an entry object is mutated with same-length text', () => {
    const index = createEntrySearchIndex()
    const value = entry({ comment: 'Dragon' })

    expect(searchEntriesByQuery([value], 'dragon', index)?.length).toBe(1)
    value.comment = 'Castle'
    expect(searchEntriesByQuery([value], 'dragon', index)).toEqual([])
    expect(searchEntriesByQuery([value], 'castle', index)?.length).toBe(1)
    expect(index.folds()).toBe(2)
  })

  test('folds a 554-entry megabyte-scale book only once across query changes', () => {
    const index = createEntrySearchIndex()
    const entries = Array.from({ length: 554 }, (_, itemIndex) => entry({
      comment: `Entry ${itemIndex}`,
      content: `${'x'.repeat(2_100)}${itemIndex === 553 ? ' final-needle' : ''}`,
    }))

    expect(searchEntriesByQuery(entries, 'final-needle', index)?.length).toBe(1)
    expect(index.folds()).toBe(554)
    expect(searchEntriesByQuery(entries, 'missing-query', index)).toEqual([])
    expect(index.folds()).toBe(554)
  })

  test('returns null and performs no folds for an inactive query', () => {
    const index = createEntrySearchIndex()
    expect(searchEntriesByQuery([entry({ content: 'large' })], '   ', index)).toBeNull()
    expect(index.folds()).toBe(0)
  })
})
