/**
 * Entry-table column model for the lorebook editors.
 *
 * Kept free of React and store imports so it can be unit-tested without a DOM.
 */

export type EntryColumnId = 'type' | 'priority' | 'position' | 'depth' | 'order' | 'keys' | 'tokens'

export interface EntryColumn {
  id: EntryColumnId
  label: string
  /** Feeds `grid-template-columns`. */
  width: string
  /** Feeds the table's minimum scroll width. */
  minWidth: number
}

/**
 * Columns in render order. Header and rows are both generated from this list, so
 * they can never disagree and no dead gap opens between the last data column and
 * the Enabled toggle.
 */
export const ENTRY_COLUMNS: EntryColumn[] = [
  { id: 'type', label: 'Type', width: 'minmax(42px, max-content)', minWidth: 74 },
  { id: 'priority', label: 'Pri', width: '44px', minWidth: 44 },
  { id: 'position', label: 'Pos', width: '44px', minWidth: 44 },
  { id: 'depth', label: 'Depth', width: '44px', minWidth: 44 },
  { id: 'order', label: 'Order', width: '44px', minWidth: 44 },
  { id: 'keys', label: 'Keys', width: 'minmax(64px, 0.6fr)', minWidth: 64 },
  { id: 'tokens', label: 'Tokens', width: '50px', minWidth: 50 },
]

export const ENTRY_NAME_MIN_WIDTH = 104
export const ENTRY_GUTTER_WIDTH = 20
/** Wide enough for the 32px `Toggle.Switch` in `sm` size. */
export const ENTRY_ENABLED_WIDTH = 38
export const ENTRY_COLUMN_GAP = 6

/**
 * Column ids introduced after `visibleEntryMetadata` first shipped.
 *
 * `mergeStoredSetting` replaces stored arrays wholesale rather than merging them,
 * so simply adding an id to the defaults leaves it invisible on every install that
 * already persisted this setting. These ids are backfilled once instead.
 */
export const ENTRY_METADATA_ADDITIONS: EntryColumnId[] = ['order']

/**
 * Current revision of {@link ENTRY_METADATA_ADDITIONS}. Bump this whenever an id
 * is appended, and add the id to the list above.
 */
export const ENTRY_METADATA_VERSION = 1

/**
 * Adds newly introduced column ids to a stored selection exactly once.
 *
 * Returns the input unchanged when there is nothing to do, so the caller can
 * compare by reference and skip a redundant settings write. Gated on
 * `storedVersion`, not on the contents of the array: inferring "pre-upgrade" from
 * the ids present cannot tell an old array apart from one where the user has
 * since unticked Order, and would silently re-tick it on every mount.
 */
export function backfillEntryMetadata(stored: string[], storedVersion = 0): string[] {
  if (storedVersion >= ENTRY_METADATA_VERSION) return stored
  const missing = ENTRY_METADATA_ADDITIONS.filter((id) => !stored.includes(id))
  if (missing.length === 0) return stored
  const insertion = new Set(missing)
  // Keep render order stable by rebuilding from ENTRY_COLUMNS, then re-appending
  // any ids the column model does not own (e.g. 'enabled').
  const known = ENTRY_COLUMNS
    .map((column) => column.id as string)
    .filter((id) => stored.includes(id) || insertion.has(id as EntryColumnId))
  const extras = stored.filter((id) => !ENTRY_COLUMNS.some((column) => column.id === id))
  return [...known, ...extras]
}

export function resolveVisibleColumns(visibleEntryMetadata: string[]): EntryColumn[] {
  return ENTRY_COLUMNS.filter((column) => visibleEntryMetadata.includes(column.id))
}

export function buildEntryGridTemplate(columns: EntryColumn[]): string {
  return [
    `${ENTRY_GUTTER_WIDTH}px`,
    `minmax(${ENTRY_NAME_MIN_WIDTH}px, 1.6fr)`,
    ...columns.map((column) => column.width),
    `${ENTRY_ENABLED_WIDTH}px`,
  ].join(' ')
}

export function buildEntryTableMinWidth(columns: EntryColumn[]): number {
  const columnWidth = columns.reduce((total, column) => total + column.minWidth, 0)
  const cells = columns.length + 2
  return ENTRY_GUTTER_WIDTH + ENTRY_NAME_MIN_WIDTH + columnWidth + ENTRY_ENABLED_WIDTH
    + cells * ENTRY_COLUMN_GAP + 14
}

/**
 * Order in which optional columns are surrendered when the pane is too narrow to
 * hold them all — first listed is dropped first.
 *
 * `keys` is off by default and is the widest flexible track; `order`/`depth`/
 * `position` are configuration a user sets once; `priority` is read more often;
 * `tokens` and `type` are the two columns a user actually scans down, so they
 * survive longest.
 *
 * This is a permutation of {@link ENTRY_COLUMNS} — every column must have a
 * defined place in the ladder, or it would be undroppable and pin the minimum
 * width forever.
 */
export const ENTRY_COLUMN_DROP_ORDER: EntryColumnId[] = [
  'keys', 'order', 'depth', 'position', 'priority', 'tokens', 'type',
]

/**
 * Narrows a user's chosen column set to what actually fits in `availableWidth`.
 *
 * This is the responsive mechanism for the entry table, and it lives here rather
 * than in CSS on purpose. A `@container` ladder would have to hard-code one
 * min-width step per column count, but the real minimum depends on *which*
 * columns the user has enabled — `buildEntryTableMinWidth(['tokens'])` is 244
 * while the full set is 594. CSS cannot see `visibleEntryMetadata`, so a static
 * ladder would manufacture horizontal scroll on a table that already fitted.
 *
 * Because this reuses {@link buildEntryTableMinWidth} verbatim, the arithmetic
 * has exactly one home and there are no breakpoint constants anywhere.
 *
 * Returns the input array by reference when nothing has to be dropped, so
 * callers can memoise on identity. A non-positive or non-finite `availableWidth`
 * (an unmeasured `ResizeObserver`, a detached node) is treated as "unknown" and
 * degrades nothing — a first paint should show the user's real columns, not a
 * one-column skeleton.
 *
 * The last remaining column is never dropped: below that floor the table is
 * allowed to scroll, which is strictly better than a table with no data in it.
 */
export function resolveResponsiveColumns(
  visible: EntryColumn[],
  availableWidth: number,
): EntryColumn[] {
  if (visible.length <= 1) return visible
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return visible

  let kept = visible
  for (const id of ENTRY_COLUMN_DROP_ORDER) {
    if (buildEntryTableMinWidth(kept) <= availableWidth) break
    if (kept.length <= 1) break
    const next = kept.filter((column) => column.id !== id)
    if (next.length !== kept.length) kept = next
  }
  return kept
}
