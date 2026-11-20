import { beforeEach, describe, expect, mock, test } from 'bun:test'

import type { WorldBookEntry } from '@/types/api'

const get = mock((..._args: unknown[]) => Promise.resolve(undefined))
const post = mock((..._args: unknown[]) => Promise.resolve(undefined))

mock.module('./client', () => ({
  del: mock(),
  get,
  patch: mock(),
  post,
  postBlob: mock(),
  put: mock(),
}))
mock.module('@/lib/downloads', () => ({ triggerBlobDownload: mock() }))

const { worldBooksApi } = await import('./world-books')

describe('worldBooksApi entry loading', () => {
  beforeEach(() => get.mockClear())

  test('forwards cancellation to an ordinary paginated entry request', async () => {
    const options = { signal: new AbortController().signal }
    const page = { data: [], total: 0, limit: 50, offset: 0 }
    get.mockResolvedValueOnce(page)

    await expect(worldBooksApi.listEntries('book-1', { limit: 50, offset: 0 }, options)).resolves.toBe(page)
    expect(get).toHaveBeenCalledWith(
      '/world-books/book-1/entries',
      { limit: 50, offset: 0 },
      options,
    )
  })

  test('walks a requested full corpus in 1000-row cancellable pages', async () => {
    const options = { signal: new AbortController().signal }
    const entries = Array.from(
      { length: 2_001 },
      (_, index) => ({ id: `entry-${index}` }) as WorldBookEntry,
    )
    get
      .mockResolvedValueOnce({ data: entries.slice(0, 1_000), total: entries.length })
      .mockResolvedValueOnce({ data: entries.slice(1_000, 2_000), total: entries.length })
      .mockResolvedValueOnce({ data: entries.slice(2_000), total: entries.length })

    await expect(worldBooksApi.listAllEntries('book-1', options)).resolves.toEqual(entries)
    expect(get).toHaveBeenCalledTimes(3)
    expect(get.mock.calls.map((call) => call[1])).toEqual([
      { limit: 1000, offset: 0, sort_by: 'order', sort_dir: 'asc' },
      { limit: 1000, offset: 1000, sort_by: 'order', sort_dir: 'asc' },
      { limit: 1000, offset: 2000, sort_by: 'order', sort_dir: 'asc' },
    ])
    expect(get.mock.calls.every((call) => call[2] === options)).toBe(true)
  })
})

describe('worldBooksApi organization contract', () => {
  beforeEach(() => { get.mockClear(); post.mockClear() })

  test('encodes each tag separately including commas, Unicode, slashes and query delimiters', async () => {
    const tags = ['faction,a', '世界 / &?#', 'villain']
    const options = { signal: new AbortController().signal }
    await worldBooksApi.listEntries('book', { folder: '', tag: tags, type: 'trigger', search: 'alpha', limit: 50 }, options)
    const [path, params, actualOptions] = get.mock.calls[0]
    expect(new URL(String(path), 'https://fixture.test').searchParams.getAll('tag')).toEqual(tags)
    expect(params).toEqual({ folder: '', type: 'trigger', search: 'alpha', limit: 50 })
    expect(actualOptions).toBe(options)
  })

  test('omits tag parameters and folder scope when selecting All entries', async () => {
    await worldBooksApi.listEntries('book', { tag: [] })
    expect(get).toHaveBeenCalledWith('/world-books/book/entries', {}, undefined)
  })

  test('reads organization facets and sends folder actions through native routes', async () => {
    await worldBooksApi.getEntryOrganization('book')
    expect(get).toHaveBeenCalledWith('/world-books/book/entry-organization')
    const input = { action: 'move' as const, folder: 'Characters', target_book_id: 'other', target_folder: '' }
    await worldBooksApi.entryFolderAction('book', input)
    expect(post).toHaveBeenCalledWith('/world-books/book/entry-folders', input)
  })

  test('forwards same-book move and additive tags without replacing unrelated metadata', async () => {
    const move = { action: 'move' as const, entry_ids: ['entry'], target_book_id: 'book', target_folder: 'Locations', expected_revisions: { entry: 2 } }
    const tags = { action: 'add_tags' as const, entry_ids: ['entry'], tags: ['villain'], expected_revisions: { entry: 3 } }
    await worldBooksApi.bulkEntryAction('book', move)
    await worldBooksApi.bulkEntryAction('book', tags)
    expect(post.mock.calls).toEqual([['/world-books/book/entries/bulk', move], ['/world-books/book/entries/bulk', tags]])
  })
})
