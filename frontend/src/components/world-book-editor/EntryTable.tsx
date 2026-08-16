import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { GripVertical, KeyRound, Lock, Sparkles } from 'lucide-react'
import clsx from 'clsx'
import { Toggle } from '@/components/shared/Toggle'
import type { EntryColumn } from '@/lib/lorebookEntryColumns'
import {
  buildEntryGridTemplate,
  buildEntryTableMinWidth,
  resolveResponsiveColumns,
} from '@/lib/lorebookEntryColumns'
import type { LorebookRowDensity } from '@/lib/lorebookRowMetrics'
import {
  DEFAULT_ENTRY_ROW_DENSITY,
  entryRowPitch,
  normalizeFontScale,
  normalizeRowDensity,
} from '@/lib/lorebookRowMetrics'
import { buildEntryIndexMap, planEntryReveal } from '@/lib/entryReveal'
import { getUiScale as readUiScale } from '@/lib/uiScale'
import { useScaledSortableStyle } from '@/lib/dndUiScale'
import { estimateTokens } from '@/lib/tokenEstimate'
import type {
  EntrySearchResult,
  EntrySearchTextRange,
} from '@/lib/lorebookEntrySearch'
import type { LorebookResolvedTokenCount as ResolvedTokenCount } from './useLorebookTokenCounts'
import type { WorldBookEntry } from '@/types/api'
import styles from './LorebookEditorLayout.module.css'

export type TriggerType = 'constant' | 'keyword' | 'vector'

export function getTriggerType(entry: WorldBookEntry): TriggerType {
  if (entry.constant) return 'constant'
  if (entry.vectorized) return 'vector'
  return 'keyword'
}

/**
 * Fallback used only when the host does not supply a resolver (no shared token
 * cache, no prefetch). Deliberately the same two steps the column always had, now
 * expressed through the shared heuristic so `~` means the same thing everywhere.
 *
 * The stored tier goes through {@link readStoredTokenCount} rather than reading
 * the extension keys directly, because reading them directly carried both of the
 * bugs that module exists to close: nothing invalidates a persisted count when
 * the content is edited, and the model it was recorded under was written but
 * never compared. Either produced a wrong number rendered *without* the `~`.
 *
 * `model: null` is not a shortcut — this path genuinely does not know the active
 * profile (the resolver that does is `useTokenCounts`, which is why the workspace
 * supplies one). A count tagged with a model therefore cannot be proven to
 * describe the current one here, so it degrades to an estimate. That is the safe
 * direction: the value is still shown, marked `~`.
 */
function getTokenEstimate(entry: WorldBookEntry): ResolvedTokenCount {
  return { value: estimateTokens(entry.content), exact: false }
}

export function getTriggerLabel(type: TriggerType): string {
  if (type === 'constant') return 'Constant'
  if (type === 'vector') return 'Semantic'
  return 'Keyword'
}

function getTriggerIcon(type: TriggerType): React.ReactNode {
  if (type === 'constant') return <Lock size={13} />
  if (type === 'vector') return <Sparkles size={13} />
  return <KeyRound size={13} />
}

/**
 * CSS Modules run with `localsConvention: 'camelCaseOnly'`, so `.trigger_constant`
 * is only exported as `triggerConstant`. Indexing by the source name silently
 * returned `undefined`, which is why trigger badges rendered uncoloured.
 */
export const TRIGGER_BADGE_CLASS: Record<TriggerType, string> = {
  constant: styles.triggerConstant,
  keyword: styles.triggerKeyword,
  vector: styles.triggerVector,
}

const POSITION_LABELS: Record<number, string> = {
  0: 'Before main prompt',
  1: 'After main prompt',
  2: 'Author’s note top',
  3: 'Author’s note bottom',
  4: 'At depth',
  7: 'At marker',
}

export function TriggerBadge({ entry, display }: { entry: WorldBookEntry; display: 'words' | 'icons' }) {
  const type = getTriggerType(entry)
  const label = getTriggerLabel(type)
  return (
    <span className={clsx(styles.triggerBadge, TRIGGER_BADGE_CLASS[type])} title={label}>
      {getTriggerIcon(type)}
      {display === 'words' && <span>{label}</span>}
    </span>
  )
}


function InlineNumberField({
  label,
  title,
  value,
  min,
  onCommit,
}: {
  label: string
  title?: string
  value: number
  min?: number
  onCommit: (value: number) => void
}) {
  return (
    <input
      key={value}
      className={styles.rowNumberInput}
      aria-label={label}
      title={title}
      type="number"
      min={min}
      defaultValue={value}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      onBlur={(event) => {
        const next = Number(event.currentTarget.value)
        if (Number.isFinite(next) && next !== value) onCommit(next)
        else event.currentTarget.value = String(value)
      }}
    />
  )
}

/**
 * Measures the table region in *layout* pixels.
 *
 * `getBoundingClientRect()` divided by {@link readUiScale} rather than
 * `entry.contentBoxSize`: the app renders under `body > * { zoom: … }`
 * (`theme/reset.css`), and whether `contentBoxSize` reports pre- or post-zoom
 * units is not something this codebase has verified. Guessing wrong would
 * reproduce the sideways-scrolling bug for every user at a UI scale other than 1
 * while passing every test at scale 1. Dividing by the scale is what the rest of
 * the app already does and is deterministic in both directions.
 */
function useAvailableWidth(
  ref: React.RefObject<HTMLDivElement | null>,
  /**
   * Maps a candidate width to the identity of the column set it would resolve to.
   * Supplied by the caller because only the caller knows `visibleColumns`.
   */
  columnSignature: (width: number) => string,
): number {
  const [availableWidth, setAvailableWidth] = useState(0)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    const measure = () => {
      const scale = readUiScale() || 1
      const next = Math.round(node.getBoundingClientRect().width / scale)
      // Commit only when the resolved column set would actually change. Dragging
      // the splitter reports a new width every frame, and this state feeds
      // nothing but `resolveResponsiveColumns` — so every frame that stayed
      // inside the same column bucket used to re-render all 554 rows to produce
      // byte-identical markup. Holding the stale width is safe precisely because
      // the signature says both widths resolve to the same columns.
      setAvailableWidth((current) => (
        current === next || columnSignature(current) === columnSignature(next)
          ? current
          : next
      ))
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    // The region's width comes from the pane, never from its own contents, so
    // dropping a column cannot feed back into this measurement and oscillate.
    //
    // Coalesced to one measurement per frame anyway: the callback forces a style
    // flush (`readUiScale` -> `getComputedStyle`) and then a layout
    // (`getBoundingClientRect`), and a ResizeObserver can deliver several
    // batches per frame.
    let frame: number | null = null
    const observer = new ResizeObserver(() => {
      if (frame != null) return
      frame = requestAnimationFrame(() => {
        frame = null
        measure()
      })
    })
    observer.observe(node)
    return () => {
      if (frame != null) cancelAnimationFrame(frame)
      observer.disconnect()
    }
    // Re-measuring when the user's column set changes is required, not incidental:
    // the committed width is only known-equivalent under the signature it was
    // committed against.
  }, [columnSignature, ref])

  return availableWidth
}

/**
 * The app-wide font scale, as a multiplier.
 *
 * `.entryRow` is `font-size: calc(10.5px * var(--lumiverse-font-scale, 1))`, and
 * `hooks/useThemeApplicator` writes that custom property onto
 * `document.documentElement`, so a theme change moves the row pitch. This is a
 * *different* variable from `--lumiverse-ui-scale`: the latter is the
 * `body > * { zoom }` factor and must never be applied to a layout-pixel row
 * estimate. `MessageList` reads the same property, for the same reason.
 */
function readEntryFontScale(): number {
  if (typeof document === 'undefined') return 1
  return normalizeFontScale(
    getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-font-scale'),
  )
}

/**
 * `data-density` is set by the workspace on an ancestor `<section>` and is what
 * `[data-density="balanced"] .entryRow { min-height }` actually reads, so reading
 * it back off the DOM cannot disagree with the stylesheet the way a duplicated
 * prop could.
 */
function readEntryRowDensity(node: HTMLElement | null): LorebookRowDensity {
  return normalizeRowDensity(node?.closest('[data-density]')?.getAttribute('data-density'))
}

interface EntryRowMetrics {
  density: LorebookRowDensity
  fontScale: number
}

/**
 * The two inputs to {@link entryRowPitch}, kept current.
 *
 * Reading them once on mount would be the bug. `@tanstack/virtual-core` clears
 * its measured-height cache only when the list is disabled or its lane count
 * changes — a new `estimateSize` does **not** clear it. So switching "Entry row
 * density" leaves a stale `offsetHeight` on every row that has already been
 * measured, and the list gains overlaps and gaps until it is remounted. The
 * caller pairs this hook with an explicit `virtualizer.measure()`.
 *
 * Both values are duplicates of state that already lives in the DOM, which is
 * why this observes rather than accepting props: the density host is owned by
 * `LorebookEditorWorkspace` and the custom property by the theme applicator, and
 * neither is this component's to re-plumb.
 */
function useEntryRowMetrics(ref: React.RefObject<HTMLDivElement | null>): EntryRowMetrics {
  const [metrics, setMetrics] = useState<EntryRowMetrics>(() => ({
    density: DEFAULT_ENTRY_ROW_DENSITY,
    fontScale: 1,
  }))

  useEffect(() => {
    const node = ref.current
    const sync = () => {
      const density = readEntryRowDensity(node)
      const fontScale = readEntryFontScale()
      setMetrics((current) => (
        current.density === density && current.fontScale === fontScale
          ? current
          : { density, fontScale }
      ))
    }

    sync()
    if (typeof MutationObserver === 'undefined') return
    // Coalesced to one read per frame: `sync` forces a style flush
    // (`getComputedStyle`), and the `<html>` inline style is also where the app
    // shell parks its viewport variables, which can be rewritten per frame while
    // a mobile keyboard animates.
    let frame: number | null = null
    const observer = new MutationObserver(() => {
      if (frame != null) return
      frame = requestAnimationFrame(() => {
        frame = null
        sync()
      })
    })
    const densityHost = node?.closest('[data-density]')
    if (densityHost) {
      observer.observe(densityHost, { attributes: true, attributeFilter: ['data-density'] })
    }
    // The theme applicator writes every token as an inline custom property on
    // `<html>`, so one attribute filter covers a font-scale change whatever
    // triggered it (preset switch, slider, character theme).
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    return () => {
      if (frame != null) cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [ref])

  return metrics
}

export interface EntryTableProps {
  /** Every entry in the open book — only the empty state distinguishes the two lists. */
  entries: WorldBookEntry[]
  filteredEntries: WorldBookEntry[]
  /** Ranked-match metadata, present only while a meaningful query is active. */
  searchResultsById?: ReadonlyMap<string, EntrySearchResult<WorldBookEntry>>
  searchActive?: boolean
  searchQuery?: string
  typeFilter?: 'all' | TriggerType
  onClearSearch?: () => void
  onClearTypeFilter?: () => void
  loading: boolean
  /** Reordering is only safe for the complete, unfiltered custom-order list. */
  reorderEnabled?: boolean
  onReorder?: (activeId: string, overId: string) => Promise<void> | void
  /**
   * The columns the *user* has enabled. Which of them actually render is decided
   * here, from the measured width — see {@link resolveResponsiveColumns}.
   */
  visibleColumns: EntryColumn[]
  /**
   * @deprecated Ignored. Both are derived from the responsive column set, which
   * only this component can know. Computing them from the unmeasured set would
   * reserve width for columns that were dropped. Safe for the caller to stop
   * passing.
   */
  entryGridTemplate?: string
  /** @deprecated Ignored — see {@link EntryTableProps.entryGridTemplate}. */
  entryTableMinWidth?: number
  selectedEntryId: string | null
  setSelectedEntryId: (entryId: string) => void
  selectedIds: string[]
  toggleEntrySelection: (entryId: string) => void
  triggerDisplay: 'words' | 'icons'
  saveEntry: (entryId: string, updates: Partial<WorldBookEntry>) => void
  /** Hover-intent token prefetch — the dwell itself lives in the scheduler. */
  onEntryPointerEnter?: (entryId: string) => void
  onEntryPointerLeave?: (entryId: string) => void
  /**
   * Resolves the Tokens cell. The workspace passes the cache-aware resolver from
   * `useTokenCounts`, so a background count re-renders this list — and only this
   * list — through `useSyncExternalStore`. Defaults to the stored-or-heuristic
   * behaviour when no resolver is supplied.
   */
  resolveTokenCount?: (entry: WorldBookEntry) => ResolvedTokenCount
  bookId?: string | null
}

/** Placeholder for rows rendered while the Tokens column is dropped — never read. */
const NO_TOKENS: ResolvedTokenCount = { value: 0, exact: false }

interface EntryRowProps {
  entry: WorldBookEntry
  searchResult?: EntrySearchResult<WorldBookEntry>
  responsiveColumns: EntryColumn[]
  selected: boolean
  checked: boolean
  triggerDisplay: 'words' | 'icons'
  /**
   * The resolved count, flattened to primitives. Passing the
   * {@link ResolvedTokenCount} object would allocate a fresh identity per row per
   * render and defeat the memo — which is the entire point of this component.
   */
  tokenValue: number
  tokenExact: boolean
  setSelectedEntryId: (entryId: string) => void
  toggleEntrySelection: (entryId: string) => void
  saveEntry: (entryId: string, updates: Partial<WorldBookEntry>) => void
  onEntryPointerEnter?: (entryId: string) => void
  onEntryPointerLeave?: (entryId: string) => void
  dragHandleAttributes?: DraggableAttributes
  dragHandleListeners?: Record<string, unknown>
  dragEnabled?: boolean
}

function mergeTextRanges(ranges: EntrySearchTextRange[]): EntrySearchTextRange[] {
  const merged: EntrySearchTextRange[] = []
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
      previous.fuzzy = previous.fuzzy || range.fuzzy
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function HighlightedText({ text, ranges }: { text: string; ranges: EntrySearchTextRange[] }) {
  const safeRanges = mergeTextRanges(ranges).map((range) => ({
    ...range,
    start: Math.max(0, Math.min(text.length, range.start)),
    end: Math.max(0, Math.min(text.length, range.end)),
  }))
  if (safeRanges.length === 0) return <>{text}</>

  const parts: React.ReactNode[] = []
  let cursor = 0
  safeRanges.forEach((range, index) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start))
    parts.push(
      <mark
        key={`${range.start}:${range.end}:${index}`}
        className={clsx(styles.entrySearchMark, range.fuzzy && styles.entrySearchMarkFuzzy)}
      >
        {text.slice(range.start, range.end)}
      </mark>,
    )
    cursor = Math.max(cursor, range.end)
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

function rangesFor(
  result: EntrySearchResult<WorldBookEntry> | undefined,
  field: 'comment' | 'primaryKey',
  valueIndex = 0,
): EntrySearchTextRange[] {
  return result?.matches
    .filter((match) => match.field === field && match.valueIndex === valueIndex)
    .map((match) => ({ start: match.start, end: match.end, fuzzy: match.fuzzy })) ?? []
}

/**
 * One row, memoised on its own data.
 *
 * The token cache's `useSyncExternalStore` subscription lives in
 * `LorebookEditorWorkspace`, not here, so **every** completed background count
 * re-renders the books pane, the toolbar, this table and the inspector. Before
 * this memo that meant reconciling ~12,000 DOM nodes to change one number; with
 * "count every entry in the open lorebook" switched on it meant 554 of those
 * passes, which is genuinely quadratic.
 *
 * The memo works only because every prop above is a primitive, a stable
 * reference, or `entry` itself — and `commitEntries` in the workspace is strictly
 * immutable, so `entry` identity changes exactly when the row's data does. The
 * five callbacks are re-stabilised by the parent (see `stableActions`), because
 * the workspace hands some of them down freshly allocated on every render and a
 * memo defeated by prop identity is pure overhead.
 */
const EntryRow = memo(function EntryRow({
  entry,
  searchResult,
  responsiveColumns,
  selected,
  checked,
  triggerDisplay,
  tokenValue,
  tokenExact,
  setSelectedEntryId,
  toggleEntrySelection,
  saveEntry,
  onEntryPointerEnter,
  onEntryPointerLeave,
  dragHandleAttributes,
  dragHandleListeners,
  dragEnabled = false,
}: EntryRowProps) {
  return (
    <div
      className={clsx(styles.entryRow, selected && styles.activeRow)}
      data-entry-id={entry.id}
      onClick={() => setSelectedEntryId(entry.id)}
      onPointerEnter={() => onEntryPointerEnter?.(entry.id)}
      onPointerLeave={() => onEntryPointerLeave?.(entry.id)}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={() => toggleEntrySelection(entry.id)}
        onClick={(event) => event.stopPropagation()}
        aria-label={`Select ${entry.comment || 'Untitled entry'}`}
      />
      <span className={styles.entryName} title={entry.comment || 'Untitled entry'}>
        <button
          type="button"
          className={styles.entryDragHandle}
          aria-label={`Reorder ${entry.comment || 'Untitled entry'}`}
          title={dragEnabled ? 'Drag to reorder' : 'Reordering is available only for the complete custom-order list'}
          disabled={!dragEnabled}
          onClick={(event) => event.stopPropagation()}
          {...dragHandleAttributes}
          {...dragHandleListeners}
        >
          <GripVertical size={12} />
        </button>
        <span className={styles.entryNameText}>
          <HighlightedText
            text={entry.comment || 'Untitled entry'}
            ranges={entry.comment ? rangesFor(searchResult, 'comment') : []}
          />
        </span>
      </span>
      {responsiveColumns.map((column) => {
        const name = entry.comment || 'entry'
        if (column.id === 'type') {
          return (
            <div key={column.id} className={styles.rowTypeControl} onClick={(event) => event.stopPropagation()}>
              <TriggerBadge entry={entry} display={triggerDisplay} />
              <select
                className={styles.rowTypeSelect}
                aria-label={`Type for ${entry.comment || 'Untitled entry'}`}
                value={getTriggerType(entry)}
                title={`Change type: ${getTriggerLabel(getTriggerType(entry))}`}
                onChange={(event) => {
                  const trigger = event.target.value as TriggerType
                  void saveEntry(entry.id, {
                    constant: trigger === 'constant',
                    vectorized: trigger === 'vector',
                  })
                }}
              >
                <option value="constant">Constant</option>
                <option value="keyword">Keyword</option>
                <option value="vector">Semantic</option>
              </select>
            </div>
          )
        }
        if (column.id === 'priority') {
          return <InlineNumberField key={column.id} label={`Priority for ${name}`} value={entry.priority} onCommit={(priority) => void saveEntry(entry.id, { priority })} />
        }
        if (column.id === 'position') {
          return (
            <InlineNumberField
              key={column.id}
              label={`Position for ${name}`}
              title={POSITION_LABELS[entry.position] ?? `Position ${entry.position}`}
              value={entry.position}
              onCommit={(position) => void saveEntry(entry.id, { position })}
            />
          )
        }
        if (column.id === 'depth') {
          return <InlineNumberField key={column.id} label={`Depth for ${name}`} min={0} value={entry.depth} onCommit={(depth) => void saveEntry(entry.id, { depth })} />
        }
        if (column.id === 'order') {
          return <InlineNumberField key={column.id} label={`Order for ${name}`} value={entry.order_value} onCommit={(order_value) => void saveEntry(entry.id, { order_value })} />
        }
        if (column.id === 'keys') {
          const keys = entry.key.join(', ')
          return (
            <span key={column.id} className={styles.rowKeys} title={keys || 'No primary keys'}>
              {entry.key.length === 0 ? '—' : entry.key.map((key, index) => (
                <span key={`${index}:${key}`}>
                  {index > 0 && ', '}
                  <HighlightedText text={key} ranges={rangesFor(searchResult, 'primaryKey', index)} />
                </span>
              ))}
            </span>
          )
        }
        // `tokens` is only in `visibleColumns` when the column is on, so the
        // header and the row always emit the same cell count. The count itself
        // was resolved by the parent — see {@link EntryRowProps.tokenValue}.
        const tokens = { value: tokenValue, exact: tokenExact }
        return (
          <span
            key={column.id}
            className={styles.rowTokens}
            title={tokens.exact ? `${tokens.value} tokens` : `About ${tokens.value} tokens (estimated from length)`}
          >
            {tokens.exact ? '' : '~'}{tokens.value}
          </span>
        )
      })}
      <span className={styles.rowEnabled} onClick={(event) => event.stopPropagation()}>
        <Toggle.Switch
          size="sm"
          checked={!entry.disabled}
          onChange={() => void saveEntry(entry.id, { disabled: !entry.disabled })}
          aria-label={`${entry.disabled ? 'Enable' : 'Disable'} ${entry.comment || 'Untitled entry'}`}
          title={entry.disabled ? 'Disabled' : 'Enabled'}
        />
      </span>
      {searchResult?.snippet && (
        <span className={styles.entrySearchSnippet}>
          <b>{searchResult.snippet.label}</b>
          <span className={styles.entrySearchSnippetText}>
            {searchResult.snippet.leadingEllipsis && '…'}
            <HighlightedText text={searchResult.snippet.text} ranges={searchResult.snippet.ranges} />
            {searchResult.snippet.trailingEllipsis && '…'}
          </span>
        </span>
      )}
      <span data-spindle-mount="world_book_entry_row" data-spindle-scope={`world-book-entry:${entry.id}:row`} style={{ display: 'contents' }} />
    </div>
  )
})

function SortableEntryRow({
  reorderEnabled,
  ...props
}: EntryRowProps & { reorderEnabled: boolean }) {
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({
    id: props.entry.id,
    disabled: !reorderEnabled,
  })
  const { setNodeRef, style } = useScaledSortableStyle({
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  })

  // This node is deliberately nested inside `.entryVirtualRow`: TanStack owns
  // the outer wrapper's translateY, while dnd-kit owns this transform.
  return (
    <div ref={setNodeRef} className={isDragging ? styles.entrySortableDragging : undefined} style={style}>
      <EntryRow
        {...props}
        dragHandleAttributes={attributes}
        dragHandleListeners={listeners}
        dragEnabled={reorderEnabled}
      />
    </div>
  )
}

export default function EntryTable({
  entries,
  filteredEntries,
  searchResultsById,
  searchActive = false,
  searchQuery = '',
  typeFilter = 'all',
  onClearSearch,
  onClearTypeFilter,
  loading,
  reorderEnabled = false,
  onReorder,
  visibleColumns,
  selectedEntryId,
  setSelectedEntryId,
  selectedIds,
  toggleEntrySelection,
  triggerDisplay,
  saveEntry,
  onEntryPointerEnter,
  onEntryPointerLeave,
  resolveTokenCount = getTokenEstimate,
  bookId,
}: EntryTableProps) {
  const regionRef = useRef<HTMLDivElement>(null)
  /** Everything rendered above the virtualized rows — see the `scrollMargin` effect. */
  const leadRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const columnSignature = useCallback((width: number) => {
    const columns = resolveResponsiveColumns(visibleColumns, width)
    let signature = ''
    for (const column of columns) signature += `${column.id}|`
    return signature
  }, [visibleColumns])
  const availableWidth = useAvailableWidth(regionRef, columnSignature)

  /**
   * The columns that actually render. Overflow used to be handled by scrolling
   * sideways, which is what the user complained about: at the shipped defaults
   * the six visible columns need 524px while `entriesPaneWidth` is 320, so the
   * full editor opened with ~204px of horizontal scroll before anything was
   * dragged.
   *
   * Header and rows below both iterate *this* array, so the cell-count
   * invariant that `grid-template-columns` depends on holds by construction —
   * no `display: none` on individual cells, which would shift every later cell
   * one track left and leave the trailing track empty.
   */
  const responsiveColumns = useMemo(
    () => resolveResponsiveColumns(visibleColumns, availableWidth),
    [visibleColumns, availableWidth],
  )
  // Derived from the surviving set, not the requested one: reserving width for a
  // dropped column would put the scrollbar straight back.
  const entryGridTemplate = useMemo(
    () => buildEntryGridTemplate(responsiveColumns),
    [responsiveColumns],
  )
  const entryTableMinWidth = useMemo(
    () => buildEntryTableMinWidth(responsiveColumns),
    [responsiveColumns],
  )
  // Resolving a count costs a hash of the entry's whole content on a cache miss.
  // Do not pay it for a column that was just dropped for being too wide.
  const tokensVisible = useMemo(
    () => responsiveColumns.some((column) => column.id === 'tokens'),
    [responsiveColumns],
  )
  // `selectedIds.includes` per row is O(rows x selection) — 307k string compares
  // after "select all" on the largest book, every render.
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])

  /**
   * Stable identities for the five callbacks the rows receive.
   *
   * `EntryRow` is memoised, and several of these arrive freshly allocated on
   * every workspace render (`toggleEntrySelection` has no `useCallback` there).
   * Latching them through a ref keeps the memo effective without reaching into a
   * component this one does not own, and the indirection is one property read per
   * invocation.
   */
  const callbacks = useRef({
    setSelectedEntryId, toggleEntrySelection, saveEntry, onEntryPointerEnter, onEntryPointerLeave,
  })
  callbacks.current = {
    setSelectedEntryId, toggleEntrySelection, saveEntry, onEntryPointerEnter, onEntryPointerLeave,
  }
  const stableActions = useMemo(() => ({
    setSelectedEntryId: (entryId: string) => callbacks.current.setSelectedEntryId(entryId),
    toggleEntrySelection: (entryId: string) => callbacks.current.toggleEntrySelection(entryId),
    saveEntry: (entryId: string, updates: Partial<WorldBookEntry>) => callbacks.current.saveEntry(entryId, updates),
    onEntryPointerEnter: (entryId: string) => callbacks.current.onEntryPointerEnter?.(entryId),
    onEntryPointerLeave: (entryId: string) => callbacks.current.onEntryPointerLeave?.(entryId),
  }), [])

  const rowMetrics = useEntryRowMetrics(regionRef)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const handleDragEnd = useCallback(({ active, over }: DragEndEvent) => {
    if (!reorderEnabled || !over || active.id === over.id) return
    void onReorder?.(String(active.id), String(over.id))
  }, [onReorder, reorderEnabled])

  /**
   * Distance from the scroll element's content origin to the first virtual row.
   *
   * The header and the loading/empty/notice states are *inside* the scroll
   * element and above the rows — deliberately, because `.entryTableContent`
   * carries the `min-width`, so the header and the rows scroll sideways together
   * and their `grid-template-columns` share an origin. The virtualizer therefore
   * needs `scrollMargin`, or every row is drawn one header-height too high.
   *
   * What is observed, and why it is sufficient: everything above the spacer is
   * wrapped in a single `.entryTableLead` box, and the only other contributor is
   * `.entryScrollList`'s constant 4px `padding-top`. So
   * `spacer.offsetTop === lead.offsetHeight + 4` identically, and a `ResizeObserver`
   * on the lead fires on *every* change to that sum — a column set that wraps the
   * header, a font-scale change, and (the case a header-only observer misses) the
   * loading, empty-book and hidden-selection divs mounting and unmounting. On the
   * very first commit `loading` is `false` and `entries` is `[]`, so the
   * empty-state div **is** mounted when this effect first runs; without the
   * unmount being observed the wrong value would latch for the whole session.
   *
   * The spacer itself is rendered unconditionally — never gated on `!loading` —
   * so `spacerRef.current` is non-null from the first commit and a slow load
   * cannot leave the margin stuck at 0.
   *
   * `offsetTop` is layout px, and `.entryTableRegion`/`.entryTableContent` have
   * no padding or border, so the value needs no conversion: it is the same space
   * as the virtualizer's `scrollTop`, `offsetHeight` and our `translateY`.
   * `null` means "not measured yet" and is what the reveal below refuses to
   * scroll against.
   */
  const [scrollMargin, setScrollMargin] = useState<number | null>(null)
  useLayoutEffect(() => {
    const spacer = spacerRef.current
    const lead = leadRef.current
    if (!spacer || !lead) return
    const sync = () => {
      const next = spacer.offsetTop
      setScrollMargin((current) => (current === next ? current : next))
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sync)
    observer.observe(lead)
    return () => observer.disconnect()
  }, [])

  /**
   * 554 rows at ~25 DOM elements each is 13,852 elements and 317-409ms of React
   * mount plus style and layout, measured; ~35 rows is 14.5ms. This is the whole
   * of the measured cost of opening the editor on a large book.
   *
   * The default `measureElement` and `observeElementRect` are used unchanged, as
   * the four other virtualized lists in this app do: this version of
   * `@tanstack/virtual-core` contains no `getBoundingClientRect` at all and works
   * in `offsetWidth`/`offsetHeight`/`scrollTop`/`scrollTo({ top })` throughout,
   * which is already the space `body > * { zoom }` leaves untouched. Overriding
   * one measurer and not the other would make it *less* internally consistent,
   * not more.
   */
  const virtualizer = useVirtualizer({
    // Rows used to be gated on `!loading`; keeping the count at 0 preserves that
    // exactly, and keeps a stale book's rows off screen while the next one loads.
    count: loading ? 0 : filteredEntries.length,
    getScrollElement: () => regionRef.current,
    estimateSize: () => entryRowPitch(rowMetrics.density, rowMetrics.fontScale),
    // The id, never the index: filtering, sorting and `commitEntries` all
    // reshuffle the array, and an index key makes React reuse the wrong row's DOM.
    getItemKey: (index) => filteredEntries[index]?.id ?? index,
    overscan: 8,
    scrollMargin: scrollMargin ?? 0,
  })

  /**
   * Changing `estimateSize` does not invalidate anything: `getMeasurements` drops
   * `itemSizeCache` only when the list is disabled or its lane count changes. So
   * a density or font-scale change has to clear it explicitly, or every row the
   * user has already scrolled past keeps the height it had under the old setting.
   */
  useEffect(() => {
    virtualizer.measure()
  }, [rowMetrics.density, rowMetrics.fontScale, virtualizer])

  // Search snippets add a measured second grid row. Clear cached heights whenever
  // the query result objects change so off-screen estimates and revealed rows
  // agree immediately, before ResizeObserver sees each mounted row individually.
  useEffect(() => {
    virtualizer.measure()
  }, [searchResultsById, virtualizer])

  /** id -> row index in the rendered list; consulted once per selection change. */
  const filteredIndexById = useMemo(() => buildEntryIndexMap(filteredEntries), [filteredEntries])
  /** Distinguishes "filtered out of view" from "the book has not arrived yet". */
  const knownEntryIds = useMemo(() => new Set(entries.map((entry) => entry.id)), [entries])
  const [selectionHiddenByFilter, setSelectionHiddenByFilter] = useState(false)

  /**
   * Reveal the selected row.
   *
   * Native `scrollIntoView` rather than arithmetic on purpose: the app renders
   * under `body > * { zoom: … }` (`theme/reset.css`), the browser computes this
   * delta in the element's own layout space, and no client-pixel value crosses
   * the zoom boundary. `readUiScale()` must **not** be introduced here — dividing
   * by it would be the bug, not the fix. (The width measurement above is the
   * opposite case: `getBoundingClientRect()` really is rendered px.)
   *
   * `block: 'nearest'` so a row that is already on screen does not jump. Clicking
   * the already-selected row sets the same id, React bails, this effect does not
   * re-run — and the `revealedEntryId` latch makes that hold even when the effect
   * *is* re-entered because the entry list changed underneath it. The list also
   * arrives one commit after the selection on open, which is why a missing row is
   * a retry rather than a failure.
   *
   * Virtualization adds the case that kills the naive version: an off-screen row
   * has no DOM node, so the query returns `null` for exactly the entries that most
   * need scrolling to. Two tiers:
   *
   * 1. the row is mounted (on screen or in overscan) -> native `scrollIntoView`,
   *    kept because it is the only path provably immune to the zoom layer and it
   *    is what the three pinned literals above describe;
   * 2. the row is virtualized away -> `virtualizer.scrollToIndex`, which works in
   *    the same layout-px space and applies `scrollMargin` itself. `align: 'auto'`
   *    is that library's spelling of `block: 'nearest'` — `getOffsetForIndex`
   *    returns the current offset unchanged unless the row is past an edge — so
   *    the tiers agree. Aligning them matters: the same click must not scroll
   *    differently depending on whether the row happened to fall inside the
   *    overscan window.
   *
   * Tier 2 refuses to run until `scrollMargin` has been measured, because the
   * offsets it derives are relative to it and the latch would freeze a wrong
   * landing spot.
   */
  const revealedEntryId = useRef<string | null>(null)
  useEffect(() => {
    const plan = planEntryReveal(
      selectedEntryId,
      revealedEntryId.current,
      (entryId) => filteredIndexById.get(entryId),
      (entryId) => knownEntryIds.has(entryId),
    )
    // Reported independently of the latch, so filtering an already-revealed entry
    // out of the list still surfaces it rather than looking like a dead click.
    setSelectionHiddenByFilter(plan.kind === 'filteredOut')
    if (plan.kind === 'clear') {
      revealedEntryId.current = null
      return
    }
    // The same condition the planner folds into `skip`, spelled out because it is
    // the cheap path and `tests/lorebook-entry-perf.test.ts` pins the literal.
    if (revealedEntryId.current === selectedEntryId) return
    // `filteredOut` and `pending` both fall out here *without* latching: the first
    // has to complete once the filter is cleared, the second once the book lands.
    if (plan.kind !== 'reveal') return
    const row = regionRef.current?.querySelector<HTMLElement>(`[data-entry-id="${selectedEntryId}"]`)
    if (row) {
      revealedEntryId.current = selectedEntryId
      row.scrollIntoView({ block: 'nearest' })
      return
    }
    if (scrollMargin === null) return
    revealedEntryId.current = selectedEntryId
    virtualizer.scrollToIndex(plan.index, { align: 'auto' })
  }, [filteredIndexById, knownEntryIds, scrollMargin, selectedEntryId, virtualizer])

  return (
    <div className={styles.entryTableRegion} ref={regionRef}>
      <span data-spindle-mount="world_book_entry_table" data-spindle-scope={`world-book:${bookId ?? entries[0]?.world_book_id ?? 'none'}:entry-table`} style={{ display: 'contents' }} />
      <div
        className={styles.entryTableContent}
        style={{
          '--lorebook-entry-columns': entryGridTemplate,
          '--lorebook-entry-min-width': `${entryTableMinWidth}px`,
        } as React.CSSProperties}
      >
        {/*
          Every non-row sibling lives in this one box, which is what makes the
          `scrollMargin` measurement above provable: `spacer.offsetTop` is this
          element's height plus `.entryScrollList`'s constant padding-top, so
          observing this box catches the empty state unmounting as well as the
          header reflowing.
        */}
        <div className={styles.entryTableLead} ref={leadRef}>
          <div className={styles.entryTableHeader}>
            <span />
            <span>Entry</span>
            {responsiveColumns.map((column) => (
              <span key={column.id} className={column.id === 'tokens' ? styles.rowTokens : undefined}>
                {column.label}
              </span>
            ))}
            <span className={styles.enabledHeader}>On</span>
          </div>
          {loading && <div className={styles.empty}>Loading entries...</div>}
          {!loading && filteredEntries.length === 0 && (
            <div className={styles.empty}>
              <span>
                {entries.length === 0
                  ? 'This lorebook has no entries yet.'
                  : searchActive
                    ? `No entries match “${searchQuery.trim()}”${typeFilter === 'all' ? '.' : ' with the current type filter.'}`
                    : 'No entries match the current type filter.'}
              </span>
              {entries.length > 0 && (
                <span className={styles.emptyActions}>
                  {searchActive && onClearSearch && <button type="button" onClick={onClearSearch}>Clear search</button>}
                  {typeFilter !== 'all' && onClearTypeFilter && <button type="button" onClick={onClearTypeFilter}>Show all types</button>}
                </span>
              )}
            </div>
          )}
          {selectionHiddenByFilter && (
            <div className={styles.entrySelectionNotice}>
              The entry open in the inspector is hidden by the current filter — clear the search or type filter to see it in this list.
            </div>
          )}
        </div>
        <div className={clsx(styles.scrollList, styles.entryScrollList)}>
          {/*
            Rendered unconditionally, including while loading and while the book
            is empty: gating it would leave `spacerRef` null through a slow load
            and the scroll margin stuck at 0 for the session. Its height is the
            virtualizer's total, so the region scrolls exactly as far as 554 real
            rows used to make it.
          */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={filteredEntries.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
              <div
                ref={spacerRef}
                className={styles.entryVirtualSpacer}
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const entry = filteredEntries[virtualRow.index]
                  if (!entry) return null
                  const tokens = tokensVisible ? resolveTokenCount(entry) : NO_TOKENS
                  return (
                    <div
                      key={virtualRow.key}
                      className={styles.entryVirtualRow}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      // `virtualRow.start` is measured from the scroll element's
                      // origin and therefore includes `scrollMargin`; the wrapper is
                      // positioned inside the spacer, which already starts there.
                      style={{ transform: `translateY(${virtualRow.start - (scrollMargin ?? 0)}px)` }}
                    >
                      <SortableEntryRow
                        entry={entry}
                        searchResult={searchResultsById?.get(entry.id)}
                        responsiveColumns={responsiveColumns}
                        selected={entry.id === selectedEntryId}
                        checked={selectedIdSet.has(entry.id)}
                        triggerDisplay={triggerDisplay}
                        tokenValue={tokens.value}
                        tokenExact={tokens.exact}
                        setSelectedEntryId={stableActions.setSelectedEntryId}
                        toggleEntrySelection={stableActions.toggleEntrySelection}
                        saveEntry={stableActions.saveEntry}
                        onEntryPointerEnter={stableActions.onEntryPointerEnter}
                        onEntryPointerLeave={stableActions.onEntryPointerLeave}
                        reorderEnabled={reorderEnabled}
                      />
                    </div>
                  )
                })}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </div>
    </div>
  )
}
