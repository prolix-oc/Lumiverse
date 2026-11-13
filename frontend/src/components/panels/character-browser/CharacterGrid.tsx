import { useRef, useState, useEffect, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useScrollGate } from '@/hooks/useScrollGate'
import { getCharacterAvatarLargeUrl, getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import { useImagePrefetch } from '@/hooks/useImagePrefetch'
import { measureLayoutHeight } from '@/lib/uiScale'
import { readLayoutVar } from '@/lib/layoutVars'
import CharacterCard from './CharacterCard'
import VirtualGrid from '@/components/shared/VirtualGrid'
import type { Character, CharacterSummary } from '@/types/api'
import styles from './CharacterGrid.module.css'

interface CharacterGridProps {
  characters: (Character | CharacterSummary)[]
  favorites: string[]
  batchMode: boolean
  batchSelected: string[]
  singleColumn?: boolean
  onOpen: (character: Character | CharacterSummary) => void
  onEdit: (id: string) => void
  onToggleFavorite: (id: string) => void
  onToggleBatch: (id: string) => void
}

const MIN_COL_WIDTH = 200
const MIN_CARD_WIDTH = 140 // narrowest card that still reads well on a phone
const GAP = 20
const MOBILE_BREAKPOINT = 600
const MOBILE_GAP = 12
const MOBILE_MAX_COLUMNS = 2
const PREFETCH_ROWS = 6
const THEME_COLUMNS_PROPERTY = '--character-grid-columns'

function getGap(width: number, desktopGap = GAP): number {
  return width <= MOBILE_BREAKPOINT ? MOBILE_GAP : desktopGap
}

function getColumnCount(width: number, desktopMinWidth = MIN_COL_WIDTH, desktopGap = GAP): number {
  if (width <= 0) return 1
  const mobile = width <= MOBILE_BREAKPOINT
  const minWidth = mobile ? MIN_CARD_WIDTH : desktopMinWidth
  const gap = mobile ? MOBILE_GAP : desktopGap
  // The row has horizontal padding totalling `gap`, so the cards and the
  // gaps between them must fit inside `width - gap`.
  const cols = Math.max(1, Math.floor(width / (minWidth + gap)))
  return mobile ? Math.min(MOBILE_MAX_COLUMNS, cols) : cols
}

function readThemeColumnCount(element: HTMLElement | null): number | null {
  if (!element) return null
  const raw = getComputedStyle(element).getPropertyValue(THEME_COLUMNS_PROPERTY).trim()
  if (!/^\d+$/.test(raw)) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export default function CharacterGrid({
  characters,
  favorites,
  batchMode,
  batchSelected,
  singleColumn,
  onOpen,
  onEdit,
  onToggleFavorite,
  onToggleBatch,
}: CharacterGridProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const geometryProbeRef = useRef<HTMLDivElement>(null)
  const columnStyleProbeRef = useRef<HTMLSpanElement>(null)
  useScrollGate(parentRef)
  const prefetchImages = useImagePrefetch()

  const [containerWidth, setContainerWidth] = useState(400)
  const [layoutMetrics, setLayoutMetrics] = useState({
    minWidth: MIN_COL_WIDTH,
    gap: GAP,
    height: 0,
  })
  const [themeColumns, setThemeColumns] = useState<number | null>(null)

  // O(1) lookups instead of O(n) includes() per card
  const favSet = useMemo(() => new Set(favorites), [favorites])
  const batchSet = useMemo(() => new Set(batchSelected), [batchSelected])

  // Keep the virtualizer's row math authoritative. Themes can request an
  // explicit column count with --character-grid-columns; when absent or
  // invalid, CharacterGrid falls back to its native responsive calculation.
  // singleColumn remains the highest-priority layout mode.
  const columns = useMemo(() => {
    if (singleColumn) return 1
    return themeColumns ?? getColumnCount(containerWidth, layoutMetrics.minWidth, layoutMetrics.gap)
  }, [singleColumn, themeColumns, containerWidth, layoutMetrics.minWidth, layoutMetrics.gap])

  // Observe container and probe geometry so CSS variable changes trigger a
  // fresh layout calculation even when the container itself does not resize.
  // The dedicated column probe mirrors the unitless theme column value into
  // observable geometry, keeping live theme edits in sync without polling.
  useEffect(() => {
    const el = parentRef.current
    if (!el) return

    const syncLayout = (entries: ResizeObserverEntry[] = []) => {
      const containerEntry = entries.find((entry) => entry.target === el)
      // Probe-only resize events exist to refresh CSS-authored values. Preserve
      // the last measured container width unless the container itself resized;
      // otherwise a layoutless clientWidth (for example in tests or while
      // temporarily detached) can collapse the responsive fallback to 1 column.
      const measuredWidth =
        entries.length === 0 ? el.clientWidth : containerEntry?.contentRect.width
      const width =
        measuredWidth !== undefined && Number.isFinite(measuredWidth) && measuredWidth >= 0
          ? measuredWidth
          : null
      const layoutElement = geometryProbeRef.current ?? el
      const rawMinWidth = readLayoutVar(layoutElement, '--character-card-min-width', MIN_COL_WIDTH)
      const minWidth = Number.isFinite(rawMinWidth) && rawMinWidth > 0 ? rawMinWidth : MIN_COL_WIDTH
      const rawGap = readLayoutVar(layoutElement, '--character-card-gap', GAP)
      const gap = Number.isFinite(rawGap) && rawGap > 0 ? rawGap : GAP
      const rawHeight = readLayoutVar(layoutElement, '--character-card-height', 0)
      const height = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : 0
      const nextThemeColumns = readThemeColumnCount(el)

      if (width !== null) {
        setContainerWidth((current) => (current === width ? current : width))
      }
      setLayoutMetrics((current) => {
        if (current.minWidth === minWidth && current.gap === gap && current.height === height) {
          return current
        }
        return { minWidth, gap, height }
      })
      setThemeColumns((current) => (current === nextThemeColumns ? current : nextThemeColumns))
    }

    syncLayout()
    const observer = new ResizeObserver(syncLayout)
    observer.observe(el)

    const geometryProbe = geometryProbeRef.current
    if (geometryProbe) observer.observe(geometryProbe)

    const columnStyleProbe = columnStyleProbeRef.current
    if (columnStyleProbe) observer.observe(columnStyleProbe)

    return () => observer.disconnect()
  }, [])

  // Compute row height from actual column width: card is 3:4 aspect (matching
  // landing page cards). Info section overlays the image bottom, so no extra
  // height is added when no desktop card-height variable is published.
  const gap = getGap(containerWidth, layoutMetrics.gap)
  const colWidth = Math.max(1, (containerWidth - gap * columns) / columns)
  const rowHeight =
    containerWidth > MOBILE_BREAKPOINT && layoutMetrics.height > 0
      ? layoutMetrics.height + gap
      : Math.ceil(colWidth * (4 / 3)) + gap
  const rowCount = Math.ceil(characters.length / columns)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 5,
    measureElement: (el) => measureLayoutHeight(el),
    paddingStart: gap,
  })

  // When the responsive or theme-authored layout changes, force the
  // virtualizer to re-measure row heights so absolute positions stay in sync
  // with the actual DOM.
  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, rowHeight, columns])

  // Prefetch avatar images for rows near the visible viewport so they're
  // already decoded when the virtualizer scrolls them into view.
  const virtualItems = virtualizer.getVirtualItems()
  const visStart = virtualItems.length > 0 ? virtualItems[0].index : -1
  const visEnd = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1
  useEffect(() => {
    if (visStart < 0 || characters.length === 0) {
      prefetchImages([])
      return
    }
    const startRow = Math.max(0, visStart - PREFETCH_ROWS)
    const endRow = Math.min(rowCount - 1, visEnd + PREFETCH_ROWS)
    const startIdx = startRow * columns
    const endIdx = Math.min(characters.length, (endRow + 1) * columns)
    const urls: string[] = []
    for (let i = startIdx; i < endIdx; i++) {
      const char = characters[i]
      if (!char) continue
      const url = getCharacterAvatarLargeUrl(char) ?? getCharacterAvatarThumbUrl(char)
      if (url) urls.push(url)
    }
    prefetchImages(urls)
  }, [visStart, visEnd, characters, columns, rowCount, prefetchImages])

  if (characters.length === 0) return null

  return (
    <div ref={parentRef} className={styles.scrollContainer} data-character-grid="">
      <div ref={geometryProbeRef} className={styles.geometryProbe} aria-hidden="true" />
      <span
        ref={columnStyleProbeRef}
        className={styles.columnCountProbe}
        data-character-grid-column-probe=""
        aria-hidden="true"
      />
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
        }}
      >
        <VirtualGrid
          items={characters}
          rows={virtualItems}
          columns={columns}
          gap={gap}
          paddingInline={gap / 2}
          className={styles.row}
          measureElement={virtualizer.measureElement}
          getItemKey={(character) => character.id}
          renderItem={(character) => (
            <CharacterCard
              character={character}
              isFavorite={favSet.has(character.id)}
              isSelected={batchSet.has(character.id)}
              batchMode={batchMode}
              useLargeTier
              onOpen={onOpen}
              onEdit={onEdit}
              onToggleFavorite={onToggleFavorite}
              onToggleBatch={onToggleBatch}
            />
          )}
        />
      </div>
    </div>
  )
}
