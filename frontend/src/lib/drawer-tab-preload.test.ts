import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { canPreloadDrawerTab, scheduleIdleDrawerPreload } from './drawer-tab-preload'

const originalNavigator = Object.getOwnPropertyDescriptor(window, 'navigator')
if (!window.navigator) Object.defineProperty(window, 'navigator', { configurable: true, value: { onLine: true } })
afterAll(() => {
  if (originalNavigator) Object.defineProperty(window, 'navigator', originalNavigator)
  else delete (window as any).navigator
})
const original = {
  timer: window.setTimeout, clearTimer: window.clearTimeout,
  idle: window.requestIdleCallback, cancelIdle: window.cancelIdleCallback,
  connection: Object.getOwnPropertyDescriptor(window.navigator, 'connection'),
  hidden: Object.getOwnPropertyDescriptor(document, 'hidden'),
}
const timers = new Map<number, () => void>()
const idleTasks = new Map<number, IdleRequestCallback>()
let nextId = 0
beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  Object.defineProperty(window.navigator, 'connection', { configurable: true, value: { saveData: false, effectiveType: '4g' } })
  window.setTimeout = ((run: () => void) => { const id = ++nextId; timers.set(id, run); return id }) as typeof window.setTimeout
  window.clearTimeout = id => { timers.delete(id) }
  window.requestIdleCallback = run => { const id = ++nextId; idleTasks.set(id, run); return id }
  window.cancelIdleCallback = id => { idleTasks.delete(id) }
})
afterEach(() => {
  window.setTimeout = original.timer
  window.clearTimeout = original.clearTimer
  window.requestIdleCallback = original.idle
  window.cancelIdleCallback = original.cancelIdle
  if (original.connection) Object.defineProperty(window.navigator, 'connection', original.connection)
  else delete (window.navigator as any).connection
  if (original.hidden) Object.defineProperty(document, 'hidden', original.hidden)
  else delete (document as any).hidden
  timers.clear()
  idleTasks.clear()
})
function runTimers() { const queued = [...timers.values()]; timers.clear(); for (const run of queued) run() }
function runIdle(remaining = 12) {
  const queued = [...idleTasks.values()]; idleTasks.clear()
  for (const run of queued) run({ timeRemaining: () => remaining, didTimeout: remaining === 0 })
}

test('idle warming waits, imports once, and cancels before timer or idle work', () => {
  let calls = 0
  const cancelled = scheduleIdleDrawerPreload(() => { calls += 1 })
  cancelled()
  runTimers(); runIdle()
  expect(calls).toBe(0)
  const cancelledIdle = scheduleIdleDrawerPreload(() => { calls += 1 })
  runTimers()
  cancelledIdle()
  runIdle()
  expect(calls).toBe(0)
  scheduleIdleDrawerPreload(() => { calls += 1 })
  runTimers()
  expect(calls).toBe(0)
  runIdle(); runIdle()
  expect(calls).toBe(1)
})

test('speculation skips data saver, slow connections, hidden pages and busy idle callbacks', () => {
  let calls = 0
  for (const connection of [{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }]) {
    Object.defineProperty(window.navigator, 'connection', { configurable: true, value: connection })
    expect(canPreloadDrawerTab()).toBe(false)
    scheduleIdleDrawerPreload(() => { calls += 1 })
    runTimers(); runIdle()
  }
  Object.defineProperty(window.navigator, 'connection', { configurable: true, value: {} })
  scheduleIdleDrawerPreload(() => { calls += 1 })
  runTimers(); runIdle(0)
  expect(calls).toBe(0)
  scheduleIdleDrawerPreload(() => { calls += 1 })
  runTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  runIdle()
  expect(calls).toBe(0)
})

test('engines without idle callbacks use one delayed, cancellable fallback', () => {
  window.requestIdleCallback = undefined as any
  let calls = 0
  const cancel = scheduleIdleDrawerPreload(() => { calls += 1 })
  cancel(); runTimers()
  expect(calls).toBe(0)
  scheduleIdleDrawerPreload(() => { calls += 1 })
  runTimers()
  expect(calls).toBe(1)
})
