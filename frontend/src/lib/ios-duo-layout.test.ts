import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { duoPaneStyle, isIOSLayoutSnapshot, resolveDuoLayout, subscribeIOSLayout, type IOSLayoutSnapshot } from './ios-duo-layout'

function snapshot(overrides: Partial<IOSLayoutSnapshot> = {}): IOSLayoutSnapshot {
  return {
    version: 1, revision: 1, width: 800, height: 720,
    horizontalSizeClass: 2, verticalSizeClass: 2, hingeStatus: 'fullyOpen',
    safeArea: { top: 20, right: 30, bottom: 20, left: 10 },
    divisions: [{ x: 400, y: 0, width: 0, height: 720, isActive: false }], occlusions: [],
    ...overrides,
  }
}

test('keeps both panes on an inactive, zero-width fold and respects asymmetric insets', () => {
  const layout = resolveDuoLayout(snapshot(), 'right')!
  expect(layout.axis).toBe('horizontal')
  expect(layout.chat).toEqual({ x: 10, y: 20, width: 390, height: 680 })
  expect(layout.drawer).toEqual({ x: 400, y: 20, width: 370, height: 680 })
  expect(duoPaneStyle(layout.drawer, layout)).toEqual({ left: '50%', top: `${20 / 720 * 100}%`, width: '46.25%', height: `${680 / 720 * 100}%` })
  expect(resolveDuoLayout(snapshot(), 'left')?.drawer).toEqual(layout.chat)
})

test('excludes the full interactive fold region when partially open', () => {
  const layout = resolveDuoLayout(snapshot({ hingeStatus: 'partiallyOpen', divisions: [{ x: 380, y: 0, width: 40, height: 720, isActive: true }] }), 'right')!
  expect(layout.chat.x + layout.chat.width).toBe(380)
  expect(layout.drawer.x).toBe(420)
})

test('places chat above navigation for a horizontal fold', () => {
  const layout = resolveDuoLayout(snapshot({ width: 720, height: 900, divisions: [{ x: 0, y: 440, width: 720, height: 20, isActive: true }] }), 'left')!
  expect(layout.axis).toBe('vertical')
  expect(layout.chat.y).toBe(20)
  expect(layout.chat.y + layout.chat.height).toBe(440)
  expect(layout.drawer.y).toBe(460)
})

test('uses the overlay layout on outer displays, small windows, and windows beside the hinge', () => {
  expect(resolveDuoLayout(snapshot({ hingeStatus: 'closed' }), 'right')).toBeNull()
  expect(resolveDuoLayout(snapshot({ divisions: [] }), 'right')).toBeNull()
  expect(resolveDuoLayout(snapshot({ width: 420 }), 'right')).toBeNull()
  expect(resolveDuoLayout(snapshot({ divisions: [{ x: -20, y: 0, width: 10, height: 720, isActive: true }] }), 'right')).toBeNull()
  expect(resolveDuoLayout(snapshot({ divisions: [{ x: 400, y: 100, width: 0, height: 300, isActive: false }] }), 'right')).toBeNull()
  expect(resolveDuoLayout(snapshot(), 'right', 1.5)).toBeNull()
})

test('keeps camera occlusions clear and falls back if no usable pane remains', () => {
  const layout = resolveDuoLayout(snapshot({ occlusions: [{ x: 700, y: 20, width: 70, height: 40, isActive: true }] }), 'right')!
  expect(layout.drawer.y).toBe(60)
  expect(resolveDuoLayout(snapshot({ occlusions: [{ x: 400, y: 20, width: 370, height: 680, isActive: true }] }), 'right')).toBeNull()
})

test('rejects malformed bridge geometry', () => {
  expect(isIOSLayoutSnapshot(snapshot({ width: NaN }))).toBe(false)
  expect(isIOSLayoutSnapshot({ ...snapshot(), divisions: [{ x: 400, y: 0, width: -1, height: 720, isActive: true }] })).toBe(false)
  expect(resolveDuoLayout(null, 'right')).toBeNull()
  expect(isIOSLayoutSnapshot({ ...snapshot(), isFoldable: 'true' })).toBe(false)
  expect(isIOSLayoutSnapshot(snapshot({ isFoldable: true, hingeStatus: 'closed', divisions: [] }))).toBe(true)
})

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
let host: EventTarget & { __LUMIVERSE_MOBILE__: boolean; __LUMIVERSE_PLATFORM__: string; __LUMIVERSE_IOS_NATIVE__: unknown }
let resolveStatus: (value: unknown) => void
let stop: (() => void) | undefined
beforeEach(() => {
  host = Object.assign(new EventTarget(), {
    __LUMIVERSE_MOBILE__: true, __LUMIVERSE_PLATFORM__: 'ios',
    __LUMIVERSE_IOS_NATIVE__: { version: 1, request() { return new Promise(resolve => { resolveStatus = resolve }) } },
  })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host })
})
afterEach(() => { stop?.(); stop = undefined })
afterAll(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const emit = (value: unknown) => host.dispatchEvent(Object.assign(new Event('lumiverse:ios-layout'), { detail: value }))

test('receives the initial layout and ignores a late snapshot after a newer fold event', async () => {
  const seen: number[] = []
  stop = subscribeIOSLayout(layout => seen.push(layout.revision))
  emit(snapshot({ revision: 3 }))
  resolveStatus(snapshot({ revision: 1 }))
  await flush()
  expect(seen).toEqual([3])
  emit(snapshot({ revision: 4, divisions: [] }))
  expect(seen).toEqual([3, 4])
})

test('unsubscribes both events and pending snapshot replies', async () => {
  const seen: number[] = []
  stop = subscribeIOSLayout(layout => seen.push(layout.revision))
  stop()
  emit(snapshot())
  resolveStatus(snapshot())
  await flush()
  expect(seen).toEqual([])
})

test('does not subscribe on other platforms', () => {
  host.__LUMIVERSE_PLATFORM__ = 'android'
  stop = subscribeIOSLayout(() => { throw new Error('Unexpected iOS layout') })
  emit(snapshot())
})
