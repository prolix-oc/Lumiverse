import { afterAll, afterEach, beforeEach, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
const globals = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document },
})
let state = 'active'
const listeners = new Set<() => void>()
mock.module('./ios-app-state', () => ({
  getIOSAppState: () => state,
  subscribeIOSAppState: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
}))
const { createIOSForegroundSync } = await import('./ios-foreground-sync')
let recovery: ReturnType<typeof createIOSForegroundSync> | undefined
const transition = (next: string) => { state = next; listeners.forEach(listener => listener()) }
const advance = async (ms: number) => { jest.advanceTimersByTime(ms); for (let i = 0; i < 12; i++) await Promise.resolve() }
beforeEach(() => { jest.useFakeTimers(); state = 'active' })
afterEach(() => { recovery?.stop(); jest.useRealTimers() })
afterAll(() => {
  mock.restore(); dom.window.close()
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('a suspended request cannot block recovery and its late reply stays aborted', async () => {
  const signals: AbortSignal[] = []
  let release!: () => void
  recovery = createIOSForegroundSync(async signal => {
    signals.push(signal)
    if (signals.length === 1) await new Promise<void>(resolve => { release = resolve })
  })
  await advance(100)
  transition('background'); await advance(0)
  expect(signals[0]!.aborted).toBe(true)
  transition('active'); await advance(100)
  expect(signals).toHaveLength(2)
  release(); await advance(0)
  expect(signals).toHaveLength(2)
})

test('a repeated native active event replaces a run even if JS missed background', async () => {
  const sync = mock(async () => { if (sync.mock.calls.length === 1) await new Promise(() => {}) })
  recovery = createIOSForegroundSync(sync)
  await advance(100)
  transition('active'); await advance(0); await advance(100)
  expect(sync).toHaveBeenCalledTimes(2)
})

test('transient errors retry with backoff and network recovery wakes them promptly', async () => {
  const sync = mock(async () => { throw new Error('offline') })
  recovery = createIOSForegroundSync(sync)
  await advance(100)
  await advance(999); expect(sync).toHaveBeenCalledTimes(1)
  await advance(1); expect(sync).toHaveBeenCalledTimes(2)
  await advance(1999); expect(sync).toHaveBeenCalledTimes(2)
  await advance(1); expect(sync).toHaveBeenCalledTimes(3)
  window.dispatchEvent(new dom.window.Event('online'))
  await advance(100); expect(sync).toHaveBeenCalledTimes(4)
  transition('background'); await advance(60_000)
  expect(sync).toHaveBeenCalledTimes(4)
})

test('events arriving during a run queue one follow-up and stop cancels all work', async () => {
  let release!: () => void
  const sync = mock(async () => { if (sync.mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve }) })
  recovery = createIOSForegroundSync(sync, 15_000)
  await advance(100)
  recovery.request(); recovery.request(); recovery.request()
  release(); await advance(0); await advance(100)
  expect(sync).toHaveBeenCalledTimes(2)
  recovery.stop(); await advance(60_000)
  expect(sync).toHaveBeenCalledTimes(2)
})

test('a lost native reply times out and recovers without an app restart', async () => {
  const sync = mock(async () => { if (sync.mock.calls.length === 1) await new Promise(() => {}) })
  recovery = createIOSForegroundSync(sync)
  await advance(100); await advance(35_000); await advance(1000)
  expect(sync).toHaveBeenCalledTimes(2)
})
