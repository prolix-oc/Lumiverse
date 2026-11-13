import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref, type RefObject } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { measureLayoutHeight } from '@/lib/uiScale'
import { getTauriMobilePlatform } from '@/lib/desktopWebView'
import {
  landingScrollOffset,
  restoreLandingVirtualSnapshot,
  sameLandingVirtualGeometry,
  type LandingVirtualGeometry,
  type LandingVirtualizerHandle,
} from '@/lib/landingVirtualSnapshot'

interface Options {
  geometry: LandingVirtualGeometry
  rowKeys: string[]
  scrollRef: RefObject<HTMLDivElement | null>
  scrollMargin: number | null
  savedSnapshot?: unknown
  initialOffset?: number
  snapshotRef: Ref<LandingVirtualizerHandle>
}

/** Restore only on mount; later layout changes must measure the live grid. */
export function useLandingVirtualizer({
  geometry: inputGeometry, rowKeys, scrollRef, scrollMargin: measuredScrollMargin,
  savedSnapshot, initialOffset, snapshotRef,
}: Options) {
  const { layout, width, columns, gap, rowEstimate, uiScale, fontScale, viewportWidth } = inputGeometry
  const geometry = useMemo(() => ({ layout, width, columns, gap, rowEstimate, uiScale, fontScale, viewportWidth }),
    [layout, width, columns, gap, rowEstimate, uiScale, fontScale, viewportWidth])
  const [restored] = useState(() => restoreLandingVirtualSnapshot(savedSnapshot, geometry, rowKeys))
  const [offset] = useState(() => landingScrollOffset(initialOffset))
  const scrollMargin = measuredScrollMargin ?? restored?.scrollMargin ?? 0
  const compactRowHeightsRef = useRef(new Map(restored?.measurements.map((item) => [item.key, item.size])))
  const measureCompactRow = useCallback((
    element: Element,
    _entry: ResizeObserverEntry | undefined,
    instance: Virtualizer<HTMLDivElement, Element>,
  ) => {
    const key = instance.options.getItemKey(instance.indexFromElement(element))
    const cachedHeight = compactRowHeightsRef.current.get(key)
    if (cachedHeight !== undefined) return cachedHeight
    // Compact rows retain their first layout height, including restored sizes.
    const height = measureLayoutHeight(element) || rowEstimate
    compactRowHeightsRef.current.set(key, height)
    return height
  }, [rowEstimate])
  const getItemKey = useCallback((index: number) => rowKeys[index] ?? index, [rowKeys])
  const virtualizer = useVirtualizer({
    count: rowKeys.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowEstimate,
    overscan: 4,
    anchorTo: 'start',
    scrollMargin,
    initialOffset: offset,
    initialMeasurementsCache: restored?.measurements,
    ...(layout === 'compact' ? { measureElement: measureCompactRow } : {}),
    // Commit a new range before Blink paints the next fling frame. Deferring
    // this update leaves the compositor scrolling beyond the mounted rows.
    useFlushSync: getTauriMobilePlatform() === 'android',
    getItemKey,
  })

  const previousGeometryRef = useRef(geometry)
  useEffect(() => {
    const previous = previousGeometryRef.current
    const unchanged = sameLandingVirtualGeometry(previous, geometry)
    const compactScaleChanged = layout === 'compact'
      && (previous.fontScale !== fontScale || previous.uiScale !== uiScale)
    previousGeometryRef.current = geometry
    // A mount-time reset would immediately throw away restored card heights.
    // Responsive changes still invalidate them. Compact rows keep their fixed
    // heights until scaling changes; row keys separate column groupings.
    if (compactScaleChanged) compactRowHeightsRef.current.clear()
    if ((layout === 'cards' && (!restored || !unchanged)) || compactScaleChanged) virtualizer.measure()
  }, [fontScale, geometry, layout, restored, uiScale, virtualizer])

  useImperativeHandle(snapshotRef, () => ({
    capture: () => ({
      rows: {
        geometry: { ...geometry },
        rowKeys: [...rowKeys],
        scrollMargin,
        measurements: virtualizer.takeSnapshot(),
      },
      // Read the DOM in this navigation handler so a same-frame scroll is
      // captured even if its observer delivery has not reached TanStack yet.
      offset: landingScrollOffset(scrollRef.current?.scrollTop ?? virtualizer.scrollOffset),
    }),
  }), [geometry, rowKeys, scrollMargin, scrollRef, virtualizer])

  return { virtualizer, scrollMargin }
}
