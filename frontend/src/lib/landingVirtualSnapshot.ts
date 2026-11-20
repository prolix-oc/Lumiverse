import type { VirtualItem } from '@tanstack/react-virtual'

export interface LandingVirtualGeometry {
  layout: 'cards' | 'compact'
  width: number
  columns: number
  gap: number
  rowEstimate: number
  uiScale: number
  fontScale: number
  viewportWidth: number
}

export interface LandingVirtualSnapshot {
  geometry: LandingVirtualGeometry
  rowKeys: string[]
  scrollMargin: number
  measurements: VirtualItem[]
}

export interface LandingVirtualizerHandle {
  capture: () => { rows: LandingVirtualSnapshot; offset: number }
}

export function sameLandingVirtualGeometry(a: LandingVirtualGeometry, b: LandingVirtualGeometry): boolean {
  return a.layout === b.layout && a.width === b.width && a.columns === b.columns
    && a.gap === b.gap && a.rowEstimate === b.rowEstimate && a.uiScale === b.uiScale
    && a.fontScale === b.fontScale && a.viewportWidth === b.viewportWidth
}

export function landingScrollOffset(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** sessionStorage is optional and may contain an older or malformed snapshot. */
export function restoreLandingVirtualSnapshot(
  value: unknown,
  geometry: LandingVirtualGeometry,
  rowKeys: readonly string[],
): LandingVirtualSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const saved = value as Partial<LandingVirtualSnapshot>
  if (!saved.geometry || !sameLandingVirtualGeometry(saved.geometry, geometry)) return null
  if (!Array.isArray(saved.rowKeys) || saved.rowKeys.length !== rowKeys.length
    || !saved.rowKeys.every((key, index) => key === rowKeys[index])) return null
  if (typeof saved.scrollMargin !== 'number' || !Number.isFinite(saved.scrollMargin) || saved.scrollMargin < 0) return null
  if (!Array.isArray(saved.measurements) || saved.measurements.length > rowKeys.length) return null

  const indices = new Set<number>()
  const measurements: VirtualItem[] = []
  for (const item of saved.measurements) {
    if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= rowKeys.length
      || indices.has(item.index) || item.key !== rowKeys[item.index] || item.lane !== 0
      || !Number.isFinite(item.start) || item.start < 0
      || !Number.isFinite(item.size) || item.size <= 0
      || !Number.isFinite(item.end) || Math.abs(item.end - item.start - item.size) > 0.01) return null
    indices.add(item.index)
    // Give the virtualizer its own plain objects, separate from route storage.
    measurements.push({ index: item.index, key: item.key, start: item.start, size: item.size, end: item.end, lane: 0 })
  }
  return { geometry: { ...geometry }, rowKeys: [...rowKeys], scrollMargin: saved.scrollMargin, measurements }
}
