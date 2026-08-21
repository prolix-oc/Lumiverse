import { beforeEach, describe, expect, mock, test } from 'bun:test'

import type { WorldBookEntry } from '@/types/api'

const get = mock((..._args: unknown[]) => Promise.resolve(undefined))

mock.module('./client', () => ({
  del: mock(),
  get,
  patch: mock(),
  post: mock(),
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
