import { Virtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { restoreLandingVirtualSnapshot, type LandingVirtualGeometry } from '../src/lib/landingVirtualSnapshot'

// Synthetic variable-height rows: compare the initial visible range before
// any DOM observers run. This measures restoration accuracy, not frame rate.
const rowKeys = Array.from({ length: 1000 }, (_, index) => `row-${index}`)
const geometry: LandingVirtualGeometry = {
  layout: 'compact', width: 960, columns: 2, gap: 12, rowEstimate: 98,
  uiScale: 1, fontScale: 1, viewportWidth: 1024,
}
function create(measurements: VirtualItem[] = [], offset = 0) {
  return new Virtualizer<HTMLDivElement, Element>({
    count: rowKeys.length,
    getScrollElement: () => null,
    getItemKey: (index) => rowKeys[index],
    estimateSize: () => geometry.rowEstimate,
    initialRect: { width: 960, height: 700 },
    scrollMargin: 120,
    initialOffset: offset,
    initialMeasurementsCache: measurements,
    observeElementRect: () => {},
    observeElementOffset: () => {},
    scrollToFn: () => {},
  })
}
const source = create()
source.getTotalSize()
for (let index = 0; index < 300; index++) source.resizeItem(index, 100 + index % 3 * 8)
source.scrollOffset = 20_000
const serialized = JSON.stringify({
  geometry, rowKeys, scrollMargin: 120, measurements: source.takeSnapshot(),
})
const restored = restoreLandingVirtualSnapshot(JSON.parse(serialized), geometry, rowKeys)!
const cold = create([], source.scrollOffset)
const warm = create(restored.measurements, source.scrollOffset)
const firstVisible = (instance: typeof source) => instance.getVirtualItems().find((item) => item.end > instance.scrollOffset!)!.index
const expected = firstVisible(source)
const results = {
  measuredRowsSaved: restored.measurements.length,
  snapshotBytes: new TextEncoder().encode(serialized).length,
  expectedFirstVisibleRow: expected,
  withoutMeasurements: { firstVisibleRow: firstVisible(cold), errorRows: Math.abs(firstVisible(cold) - expected) },
  withMeasurements: { firstVisibleRow: firstVisible(warm), errorRows: Math.abs(firstVisible(warm) - expected) },
}
console.log(JSON.stringify(results, null, 2))
if (results.withMeasurements.errorRows !== 0) throw new Error('Snapshot restoration changed the initial visible row')
