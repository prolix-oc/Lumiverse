import { describe, expect, mock, test } from 'bun:test'
import { createHistoryPageLoader } from './history-page-loader'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('shared history pages', () => {
  test('foreground scrolling joins a pending prefetch and reuses the completed page', async () => {
    const loader = createHistoryPageLoader<number[]>()
    const response = deferred<number[]>()
    const read = mock(() => response.promise)
    const prefetch = loader.load('chat/before/50', read)
    const foreground = loader.load('chat/before/50', read)
    expect(foreground).toBe(prefetch)
    response.resolve([1, 2])
    expect(await foreground).toEqual([1, 2])
    expect(await loader.load('chat/before/50', read)).toEqual([1, 2])
    expect(read).toHaveBeenCalledTimes(1)
    loader.reset()
  })

  test('A → B → A cannot reuse the first navigation response, even if abort is ignored', async () => {
    const loader = createHistoryPageLoader<number>()
    const old = deferred<number>(), current = deferred<number>()
    let oldSignal!: AbortSignal
    const first = loader.load('A', (signal) => { oldSignal = signal; return old.promise })
    loader.reset()
    loader.load('B', async () => 2)
    loader.reset()
    const last = loader.load('A', () => current.promise)
    expect(oldSignal.aborted).toBe(true)
    old.resolve(1)
    current.resolve(3)
    expect(await first).toBeUndefined()
    expect(await last).toBe(3)
  })

  test('a changed boundary aborts speculation; an old failure cannot clear the new request', async () => {
    const loader = createHistoryPageLoader<number>()
    const old = deferred<number>(), current = deferred<number>()
    const first = loader.load('old', () => old.promise)
    const read = mock(() => current.promise)
    const last = loader.load('new', read)
    old.reject(new Error('cancelled'))
    expect(await first).toBeUndefined()
    expect(loader.load('new', read)).toBe(last)
    current.resolve(3)
    expect(await last).toBe(3)
    expect(read).toHaveBeenCalledTimes(1)
  })

  test('failed pages can be retried', async () => {
    const loader = createHistoryPageLoader<number>()
    await expect(loader.load('page', async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(await loader.load('page', async () => 42)).toBe(42)
  })
})
