import { useMemo, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { Plus, Search, SlidersHorizontal, X } from 'lucide-react'
import clsx from 'clsx'
import type { WorldBook } from '@/types/api'
import SearchableSelect, { type SearchableSelectOption } from '@/components/shared/SearchableSelect'
import type {
  BulkEnabledSelection,
  BulkPositionSelection,
  BulkTriggerSelection,
} from '@/lib/lorebookBulkPatch'
import { TRIGGER_BADGE_CLASS, type TriggerType } from './EntryTable'
import styles from './LorebookEditorLayout.module.css'

export interface EntriesToolbarProps {
  variant: 'full' | 'half'
  /** Only the half variant renders the inline book picker. */
  books: WorldBook[]
  selectedBookId: string | null
  setSelectedBookId: (bookId: string | null) => void
  /**
   * Optional. When supplied, the half variant grows a "New lorebook" button
   * beside the picker — the full variant already has one at the foot of its
   * Books pane, the half variant previously had no way to create a book at all.
   */
  onCreateBook?: () => void
  entrySearch: string
  setEntrySearch: (value: string) => void
  entrySearchInputRef: RefObject<HTMLInputElement | null>
  searchActive: boolean
  matchCount: number
  totalEntryCount: number
  bulkVisible: boolean
  setBulkVisible: Dispatch<SetStateAction<boolean>>
  /** Total entries in the open book — the count on the "All" filter chip. */
  entryCount: number
  typeCounts: Record<TriggerType, number>
  typeFilter: 'all' | TriggerType
  setTypeFilter: (value: 'all' | TriggerType) => void
  selectedIds: string[]
  bulkPriority: string
  setBulkPriority: (value: string) => void
  bulkPosition: BulkPositionSelection
  setBulkPosition: (value: BulkPositionSelection) => void
  bulkDepth: string
  setBulkDepth: (value: string) => void
  bulkTrigger: BulkTriggerSelection
  setBulkTrigger: (value: BulkTriggerSelection) => void
  bulkEnabled: BulkEnabledSelection
  setBulkEnabled: (value: BulkEnabledSelection) => void
  /**
   * False while every control is still in its "leave as is" state. Apply would
   * send an empty patch, which the server rejects outright.
   */
  bulkHasMutation: boolean
  applyBulk: () => void
}

export default function EntriesToolbar({
  variant,
  books,
  selectedBookId,
  setSelectedBookId,
  onCreateBook,
  entrySearch,
  setEntrySearch,
  entrySearchInputRef,
  searchActive,
  matchCount,
  totalEntryCount,
  bulkVisible,
  setBulkVisible,
  entryCount,
  typeCounts,
  typeFilter,
  setTypeFilter,
  selectedIds,
  bulkPriority,
  setBulkPriority,
  bulkPosition,
  setBulkPosition,
  bulkDepth,
  setBulkDepth,
  bulkTrigger,
  setBulkTrigger,
  bulkEnabled,
  setBulkEnabled,
  bulkHasMutation,
  applyBulk,
}: EntriesToolbarProps) {
  /*
   * `sublabel` carries the folder as well as `group` on purpose.
   * `SearchableSelect` filters `label` + `sublabel` only — `group` is used for
   * the section headers and is never searched, and there is no predicate prop.
   * Without the sublabel the half picker would search names while the full
   * editor's Books pane (via `filterBooks`) searches name + folder, which is
   * exactly the divergence `lib/lorebookBookSearch.ts` exists to prevent.
   */
  const bookOptions = useMemo<SearchableSelectOption[]>(
    () => books.map((book) => {
      const folder = book.folder?.trim() || undefined
      return { value: book.id, label: book.name, sublabel: folder, group: folder }
    }),
    [books],
  )

  return (
    <>
      <div className={styles.entriesToolbar}>
        {variant === 'half' && (
          <>
            <SearchableSelect
              className={styles.halfBookPicker}
              triggerClassName={styles.halfBookPickerTrigger}
              options={bookOptions}
              value={selectedBookId ?? ''}
              onChange={(value) => setSelectedBookId(value || null)}
              /*
               * Mandatory: `.workspace` and `.entriesPane` are both
               * `overflow: hidden`, so an inline popover would be clipped.
               * The portaled popover is z-index 10002, which clears the half
               * host's mobile 10000 and the full editor's 10001 backdrop, and
               * SearchableSelect already divides by `--lumiverse-ui-scale`
               * when positioning, so `body > * { zoom }` does not shift it.
               */
              portal
              /*
               * The default threshold is 8, which *hides* the search field for
               * small libraries. The whole point of this control is a visible
               * "search lorebooks", so it must show at 2-3 books:
               * `showSearch = options.length > searchThreshold`.
               */
              searchThreshold={0}
              searchPlaceholder="Search lorebooks..."
              placeholder="Select a lorebook"
              ariaLabel="Lorebook"
              minWidth={260}
              maxHeight={320}
            />
            {onCreateBook && (
              <button
                type="button"
                className={styles.toolbarToggle}
                onClick={onCreateBook}
                title="New lorebook"
                aria-label="New lorebook"
              >
                <Plus size={14} />
              </button>
            )}
          </>
        )}
        <div className={styles.searchField}>
          <Search size={14} aria-hidden />
          <input
            ref={entrySearchInputRef}
            type="search"
            value={entrySearch}
            onChange={(event) => setEntrySearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || entrySearch.length === 0) return
              event.preventDefault()
              event.stopPropagation()
              setEntrySearch('')
            }}
            placeholder="Search entries..."
            aria-label="Search lorebook entries"
          />
          {(searchActive || typeFilter !== 'all') && (
            <span
              className={styles.entrySearchCount}
              aria-live="polite"
              aria-label={`${matchCount} of ${totalEntryCount} entries shown`}
            >
              {matchCount}/{totalEntryCount}
            </span>
          )}
          {entrySearch.length > 0 && (
            <button
              type="button"
              className={styles.entrySearchClear}
              onClick={() => setEntrySearch('')}
              title="Clear entry search"
              aria-label="Clear entry search"
            >
              <X size={13} />
            </button>
          )}
        </div>
        <button
          type="button"
          className={clsx(styles.toolbarToggle, bulkVisible && styles.toolbarToggleActive)}
          onClick={() => setBulkVisible((value) => !value)}
          title={bulkVisible ? 'Hide bulk edit' : 'Show bulk edit'}
          aria-label={bulkVisible ? 'Hide bulk edit' : 'Show bulk edit'}
          aria-pressed={bulkVisible}
        >
          <SlidersHorizontal size={13} />
        </button>
      </div>

      <div className={styles.typeFilterRow} role="group" aria-label="Filter entries by trigger type">
        {([
          ['all', 'All', entryCount],
          ['constant', 'Constant', typeCounts.constant],
          ['keyword', 'Keyword', typeCounts.keyword],
          ['vector', 'Semantic', typeCounts.vector],
        ] as const).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            className={clsx(
              styles.typeFilterChip,
              value !== 'all' && TRIGGER_BADGE_CLASS[value],
              typeFilter === value && styles.typeFilterChipActive,
            )}
            aria-pressed={typeFilter === value}
            onClick={() => setTypeFilter(value)}
          >
            {label}<b>{count}</b>
          </button>
        ))}
      </div>

      {bulkVisible && (
        <div className={styles.bulkBar}>
          <strong>{selectedIds.length} selected</strong>
          {/*
            * Every control here starts in an explicit "leave as is" state — an
            * empty box or an Unchanged option — and Apply only sends the keys the
            * user actually set. The old bar showed 10 / 0 / 4 / Keyword as if they
            * were selections, so a State-only Apply silently rewrote all four of
            * those columns on every selected entry.
            */}
          <label><span>Pri</span><input aria-label="Bulk priority" type="number" placeholder="Unchanged" value={bulkPriority} onChange={(event) => setBulkPriority(event.target.value)} /></label>
          <label><span>Pos</span><select aria-label="Bulk position" value={bulkPosition} onChange={(event) => setBulkPosition(event.target.value)}>
            <option value="unchanged">Unchanged</option>
            <option value="0">Before</option>
            <option value="1">After</option>
            <option value="4">At depth</option>
            <option value="7">At marker</option>
          </select></label>
          <label><span>Depth</span><input aria-label="Bulk depth" type="number" min={0} placeholder="Unchanged" value={bulkDepth} onChange={(event) => setBulkDepth(event.target.value)} /></label>
          <label><span>Type</span><select aria-label="Bulk trigger" value={bulkTrigger} onChange={(event) => setBulkTrigger(event.target.value as BulkTriggerSelection)}>
            <option value="unchanged">Unchanged</option>
            <option value="constant">Constant</option>
            <option value="keyword">Keyword</option>
            <option value="vector">Semantic</option>
          </select></label>
          <label><span>State</span><select aria-label="Bulk enabled" value={bulkEnabled} onChange={(event) => setBulkEnabled(event.target.value as typeof bulkEnabled)}>
            <option value="unchanged">Unchanged</option>
            <option value="enabled">Enable</option>
            <option value="disabled">Disable</option>
          </select></label>
          <button
            type="button"
            onClick={() => void applyBulk()}
            disabled={selectedIds.length === 0 || !bulkHasMutation}
            title={bulkHasMutation ? undefined : 'Set at least one field to apply'}
          >Apply</button>
        </div>
      )}
    </>
  )
}
