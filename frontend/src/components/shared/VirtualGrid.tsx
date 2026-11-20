import { useCallback, useLayoutEffect, useRef, type Key, type ReactNode } from 'react'

interface VirtualRow {
  index: number
  key: Key
  start: number
}

interface VirtualGridProps<T> {
  items: readonly T[]
  rows: readonly VirtualRow[]
  columns: number
  gap: number
  paddingInline?: number
  scrollMargin?: number
  className?: string
  getItemKey: (item: T) => Key
  renderItem: (item: T, index: number) => ReactNode
  measureElement: (element: HTMLDivElement | null) => void
}

function VirtualGridRow({
  row,
  gridRow,
  columns,
  gap,
  measureElement,
}: {
  row: VirtualRow
  gridRow: number
  columns: number
  gap: number
  measureElement: VirtualGridProps<unknown>['measureElement']
}) {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const setRowRef = useCallback((element: HTMLDivElement | null) => {
    rowRef.current = element
    if (!element) measureElement(null)
  }, [measureElement])

  useLayoutEffect(() => {
    // Prune detached measurement nodes before registering this row. Its DOM
    // identity follows the virtualizer's key, while image cells keep item keys.
    // Avatar-only updates leave these dependencies and measurements intact.
    measureElement(null)
    measureElement(rowRef.current)
  }, [columns, gap, measureElement, row.index, row.key])

  return (
    <div
      ref={setRowRef}
      data-index={row.index}
      aria-hidden="true"
      style={{
        gridRow,
        gridColumn: '1 / -1',
        minHeight: 0,
        visibility: 'hidden',
        pointerEvents: 'none',
      }}
    />
  )
}

/**
 * Render a contiguous virtual row range as one CSS grid. Every visible entry
 * is a keyed sibling, so filtering, sorting, and column changes can move it
 * between rows without remounting its image. Empty measurement nodes stretch
 * over each grid row, including its tallest cell and trailing gap. They keep
 * the virtualizer's row identity independent of the image-bearing entries;
 * offscreen entries remain unmounted.
 */
export default function VirtualGrid<T>({
  items,
  rows,
  columns,
  gap,
  paddingInline = 0,
  scrollMargin = 0,
  className,
  getItemKey,
  renderItem,
  measureElement,
}: VirtualGridProps<T>) {
  return (
    <div
      className={className}
      data-virtual-grid=""
      style={{
        position: 'absolute',
        top: (rows[0]?.start ?? scrollMargin) - scrollMargin,
        left: 0,
        width: '100%',
        boxSizing: 'border-box',
        display: 'grid',
        // TanStack owns scroll correction. Blink must not choose a recycled
        // card as a second scroll anchor when the visible row range changes.
        overflowAnchor: 'none',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        alignItems: 'stretch',
        columnGap: gap,
        rowGap: 0,
        paddingInline,
      }}
    >
      {rows.flatMap((row, visibleRow) => {
        const start = row.index * columns
        return items.slice(start, start + columns).map((item, column) => (
          <div
            key={getItemKey(item)}
            style={{
              gridRow: visibleRow + 1,
              gridColumn: column + 1,
              minWidth: 0,
              boxSizing: 'border-box',
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr)',
              alignItems: 'start',
              paddingBottom: gap,
            }}
          >
            {renderItem(item, start + column)}
          </div>
        ))
      })}
      {rows.map((row, visibleRow) => (
        <VirtualGridRow
          key={row.key}
          row={row}
          gridRow={visibleRow + 1}
          columns={columns}
          gap={gap}
          measureElement={measureElement}
        />
      ))}
    </div>
  )
}
