import { describe, expect, test } from 'bun:test'
import { Virtualizer } from '@tanstack/react-virtual'
import {
  landingScrollOffset,
  restoreLandingVirtualSnapshot,
  type LandingVirtualGeometry,
  type LandingVirtualSnapshot,
} from './landingVirtualSnapshot'

const geometry: LandingVirtualGeometry = {
  layout: 'cards', width: 960, columns: 4, gap: 20, rowEstimate: 50, uiScale: 1, fontScale: 1, viewportWidth: 1024,
}
const rowKeys = Array.from({ length: 200 }, (_, index) => JSON.stringify([`chat-${index}`]))
function virtualizer(initialMeasurementsCache = [], initialOffset = 0) {
  return new Virtualizer<HTMLDivElement, Element>({
    count: rowKeys.length,
    getScrollElement: () => null,
    estimateSize: () => geometry.rowEstimate,
    getItemKey: (index) => rowKeys[index],
    scrollMargin: 120,
    initialRect: { width: 960, height: 400 },
    initialMeasurementsCache,
    initialOffset,
    observeElementRect: () => {},
    observeElementOffset: () => {},
    scrollToFn: () => {},
  })
}
function snapshot(): LandingVirtualSnapshot {
  return { geometry, rowKeys, scrollMargin: 120, measurements: [{ index: 0, key: rowKeys[0], start: 120, size: 90, end: 210, lane: 0 }] }
}

test('round-trips sparse measured rows and a deep offset through the installed TanStack virtualizer', () => {
  const first = virtualizer()
  first.getTotalSize()
  first.resizeItem(0, 90)
  first.resizeItem(12, 120)
  first.resizeItem(50, 80)
  first.scrollOffset = 3800
  const saved = JSON.parse(JSON.stringify({ ...snapshot(), measurements: first.takeSnapshot() }))
  expect(saved.measurements.map((item) => item.index)).toEqual([0, 12, 50])
  const restored = restoreLandingVirtualSnapshot(saved, geometry, rowKeys)!
  const second = virtualizer(restored.measurements, first.scrollOffset)

  expect(second.getTotalSize()).toBe(first.getTotalSize())
  expect(second.getVirtualItems()).toEqual(first.getVirtualItems())
  expect(second.getVirtualItems()[0].index).toBeGreaterThan(50)
  expect(second.itemSizeCache.get(rowKeys[12])).toBe(120)
  expect(second.itemSizeCache.has(rowKeys[13])).toBe(false)
  second.resizeItem(12, 200)
  expect(saved.measurements.find((item) => item.index === 12).size).toBe(120)
  second.measure()
  expect(second.getTotalSize()).toBe(rowKeys.length * geometry.rowEstimate)
  expect(second.itemSizeCache.size).toBe(0)
})

describe('landing measurement compatibility', () => {
  for (const patch of [
    { width: 940 }, { columns: 3 }, { layout: 'compact' }, { gap: 12 },
    { rowEstimate: 60 }, { uiScale: 1.2 }, { fontScale: 1.3 }, { viewportWidth: 390 },
  ] as Partial<LandingVirtualGeometry>[]) {
    test(`discards stale ${Object.keys(patch)[0]}`, () => {
      expect(restoreLandingVirtualSnapshot(snapshot(), { ...geometry, ...patch }, rowKeys)).toBeNull()
    })
  }
  test('discards reordered, deleted, and replaced rows', () => {
    const reversed = [...rowKeys].reverse()
    const deleted = rowKeys.slice(1)
    const replaced = [...rowKeys]
    replaced[0] = '["replacement"]'
    for (const keys of [reversed, deleted, replaced]) {
      expect(restoreLandingVirtualSnapshot(snapshot(), geometry, keys)).toBeNull()
    }
  })
  test('ignores missing, old, or malformed stored measurements', () => {
    const good = snapshot()
    for (const saved of [
      undefined, null, {}, { ...good, geometry: null }, { ...good, rowKeys: {} },
      { ...good, measurements: null }, { ...good, scrollMargin: NaN },
      { ...good, measurements: [null] }, { ...good, measurements: [...good.measurements, ...good.measurements] },
      ...[
        { index: -1 }, { index: 1.5 }, { index: 201 }, { key: 'other' }, { lane: 1 },
        { size: -1 }, { size: 0 }, { size: Infinity }, { start: -1 }, { end: 999 },
      ].map((patch) => ({ ...good, measurements: [{ ...good.measurements[0], ...patch }] })),
    ]) {
      expect(restoreLandingVirtualSnapshot(saved, geometry, rowKeys)).toBeNull()
    }
  })
  test('allows an empty measurement cache, and copies plain data out of route state', () => {
    const saved = snapshot()
    const restored = restoreLandingVirtualSnapshot(saved, geometry, rowKeys)!
    restored.measurements[0].size = 999
    restored.rowKeys[0] = 'changed'
    expect(saved.measurements[0].size).toBe(90)
    expect(saved.rowKeys[0]).toBe(rowKeys[0])
    expect(restoreLandingVirtualSnapshot({ ...saved, measurements: [] }, geometry, rowKeys)?.measurements).toEqual([])
  })
  test('sanitizes invalid scroll offsets', () => {
    for (const value of [undefined, null, '40', NaN, Infinity, -1]) expect(landingScrollOffset(value)).toBe(0)
    expect(landingScrollOffset(3800.5)).toBe(3800.5)
  })
})
