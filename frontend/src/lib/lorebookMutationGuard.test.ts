import { describe, expect, test } from 'bun:test'
import { refreshLorebookIfCurrent, runLorebookReorderIfCurrent } from './lorebookMutationGuard'

describe('lorebook mutation selection guard', () => {
  test('rejects a refresh completion when selection changes while it is in flight', async () => {
    let currentBookId: string | null = 'book-a'
    let finishRefresh!: () => void
    const refresh = new Promise<void>((resolve) => { finishRefresh = resolve })

    const completion = refreshLorebookIfCurrent(
      'book-a',
      () => currentBookId,
      () => refresh,
    )
    currentBookId = 'book-b'
    finishRefresh()

    expect(await completion).toBe(false)
  })

  test('accepts a refresh that completes for the same selected book', async () => {
    expect(await refreshLorebookIfCurrent('book-a', () => 'book-a', async () => {})).toBe(true)
  })

  test('does not commit stale reorder data or saved state after switching books', async () => {
    let currentBookId: string | null = 'book-a'
    let visibleEntries = ['book-a:old']
    let saved = false
    let finishRefresh!: () => void
    const refreshGate = new Promise<void>((resolve) => { finishRefresh = resolve })

    const operation = runLorebookReorderIfCurrent({
      bookId: 'book-a',
      getCurrentBookId: () => currentBookId,
      reorder: async () => {},
      refresh: async () => {
        await refreshGate
        if (currentBookId === 'book-a') visibleEntries = ['book-a:reordered']
      },
      onSaved: () => { saved = true },
    })

    currentBookId = 'book-b'
    visibleEntries = ['book-b:entry']
    finishRefresh()

    expect(await operation).toBe(false)
    expect(visibleEntries).toEqual(['book-b:entry'])
    expect(saved).toBe(false)
  })
})
