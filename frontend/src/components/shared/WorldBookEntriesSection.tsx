import WorldBookColumnHandle from './WorldBookColumnHandle'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { useWorldBookEntryLabels } from '@/lib/i18n/worldBookEntryLabels'
import { useLoomOptionLabels } from '@/lib/i18n/loomOptionLabels'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  GripVertical,
  Hash,
  MoreVertical,
  MoveRight,
  Plus,
  Plug,
  Search,
  Square,
  Tag,
  Trash2,
  X,
  ArrowBigUp,
  ArrowBigDown,
  BetweenHorizontalStart,
  BetweenHorizontalEnd,
  Lock,
  MapPin,
  Zap,
} from 'lucide-react'
import {
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  DragOverlay,
  closestCenter,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DraggableAttributes,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { DndContext, useScaledSortableStyle } from '@/lib/dndUiScale'
import { useScrollGate } from '@/hooks/useScrollGate'
import useIsMobile from '@/hooks/useIsMobile'
import { useEntryWorkspace } from './useEntryWorkspace'
import { invalidateTokenCountsForEntry, useTokenCounts, useTokenCountSweep } from '@/hooks/useTokenCounts'
import clsx from 'clsx'
import { worldBooksApi } from '@/api/world-books'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import type {
  WorldBookChangedPayload,
  WorldBookEntryChangedPayload,
  WorldBookEntryDeletedPayload,
} from '@/types/ws-events'
import WorldBookEntryEditor, { type EntryEditorConflictState } from '@/components/shared/WorldBookEntryEditor'
import WorldBookTokenReportModal from '@/components/panels/world-book/WorldBookTokenReportModal'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import { ModalPresentation } from '@/components/shared/ModalPresentation'
import SearchableSelect from '@/components/shared/SearchableSelect'
import { FormField, Select, TextInput, Button } from '@/components/shared/FormComponents'
import Pagination from '@/components/shared/Pagination'
import EntryOrganizationControls, { EntryFolderList, type EntryOrganizationHandle } from './EntryOrganizationControls'
import { useStore } from '@/store'
import type {
  WorldBook,
  WorldBookEntry,
  WorldBookEntryBulkActionInput,
  WorldBookEntryOrganizationSummary,
} from '@/types/api'
import type {
  WorldBookEntrySortBy,
  WorldBookEntrySortDir,
  WorldBookEntryPageSize,
  WorldBookEntryViewPreference,
} from '@/types/store'
import styles from './WorldBookEntriesSection.module.css'
import { clearSearchOnEscape } from '@/lib/clearableSearch'
import { loadLorebookSearchEntries } from '@/lib/loadLorebookSearchEntries'
import { classifyWorldBookEntryMutationError, type WorldBookEntryMutationIssue } from '@/lib/worldBookEntryConflict'
import { estimateTokens } from '@/lib/tokenEstimate'
import { scheduleMicrotask } from '@/lib/schedule-microtask'
import {
  createEntrySearchIndex,
  searchEntriesByQuery,
  type EntrySearchResult,
  type EntrySearchTextRange,
} from '@/lib/lorebookEntrySearch'

const DEFAULT_PAGE_SIZE = 50 as const
const ENTRY_FIELD_VISIBLE_TOP_GUTTER = 12
const ENTRY_FIELD_KEYBOARD_GUTTER = 72
const ENTRY_FIELD_REVEAL_THRESHOLD = 10
const ENTRY_FIELD_RESIZED_VIEWPORT_SETTLE_DELAY = 160
const ENTRY_FIELD_FOCUS_SETTLE_DELAYS = [40, 180, 360, 520] as const
const TOKEN_PREFETCH_DWELL_MS = 180

export interface WorldBookEntriesSectionBookResetState {
  entryPage: number
  entrySearchFilter: string
  entryTypeFilter: 'all' | 'trigger' | 'constant' | 'vector'
  mobileListOptionsOpen: boolean
  selectedEntryId: string | null
  showTokenReport: boolean
  selectMode: boolean
  selectedIds: string[]
  contextMenu: null
  typeMenu: null
  positionMenu: null
  bulkActionsMenu: null
  activationState: null
}

export interface WorldBookEntriesSectionViewState extends WorldBookEntriesSectionBookResetState {
  sortBy: WorldBookEntrySortBy
  sortDir: WorldBookEntrySortDir
  pageSize: WorldBookEntryPageSize
}

export function resolveWorldBookEntryViewPreference(
  preference: WorldBookEntryViewPreference | undefined,
): WorldBookEntryViewPreference {
  return preference ?? {
    sortBy: 'custom',
    sortDir: 'asc',
    pageSize: DEFAULT_PAGE_SIZE,
  }
}

export function applyWorldBookEntryViewPreference(
  state: WorldBookEntriesSectionViewState,
  preference: WorldBookEntryViewPreference | undefined,
): WorldBookEntriesSectionViewState {
  return { ...state, ...resolveWorldBookEntryViewPreference(preference) }
}

export function getWorldBookEntriesSectionBookResetState(): WorldBookEntriesSectionBookResetState {
  return {
    entryPage: 1,
    entrySearchFilter: '',
    entryTypeFilter: 'all',
    mobileListOptionsOpen: false,
    selectedEntryId: null,
    showTokenReport: false,
    selectMode: false,
    selectedIds: [],
    contextMenu: null,
    typeMenu: null,
    positionMenu: null,
    bulkActionsMenu: null,
    activationState: null,
  }
}

export function shouldLoadFullWorldBookEntryCorpus(
  search: string,
  typeFilter: 'all' | 'trigger' | 'constant' | 'vector',
  pageSize: WorldBookEntryPageSize,
): boolean {
  return search.trim().length > 0 || typeFilter !== 'all' || pageSize === 'all'
}

/** Ignore WORLD_BOOK_ENTRY_CHANGED echoes of our own writes for this long. */
const SELF_ECHO_WINDOW_MS = 2_000

function isEditableEntryField(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false
  if (!target.closest('[data-world-book-entry-editor="true"]')) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly
  if (target instanceof HTMLSelectElement) return !target.disabled
  if (!(target instanceof HTMLInputElement) || target.disabled || target.readOnly) return false

  return ![
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ].includes(target.type)
}

function parseCssPx(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function usesBrowserResizedKeyboardViewport(): boolean {
  const root = document.documentElement
  return root.hasAttribute('data-pwa') && root.hasAttribute('data-resizes-content')
}

function getEntryFieldBottomGutter(container: HTMLElement): number {
  const style = getComputedStyle(container)
  const footerHeight = parseCssPx(style.getPropertyValue('--worldbook-footer-height'))
  if (usesBrowserResizedKeyboardViewport()) {
    return footerHeight + ENTRY_FIELD_VISIBLE_TOP_GUTTER
  }
  return Math.max(ENTRY_FIELD_KEYBOARD_GUTTER, footerHeight + ENTRY_FIELD_VISIBLE_TOP_GUTTER)
}

function getEntryFieldRevealDelta(target: HTMLElement, container: HTMLElement) {
  const targetRect = target.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  const viewportBottom = window.visualViewport?.height ?? window.innerHeight
  const visibleTop = Math.max(containerRect.top, 0) + ENTRY_FIELD_VISIBLE_TOP_GUTTER
  const visibleBottom = Math.min(containerRect.bottom, viewportBottom) - getEntryFieldBottomGutter(container)

  if (targetRect.bottom > visibleBottom) {
    return targetRect.bottom - visibleBottom
  }
  if (targetRect.top < visibleTop) {
    return targetRect.top - visibleTop
  }
  return 0
}

function revealEntryFieldTarget(target: HTMLElement | null, container: HTMLElement | null) {
  if (!target || !container || !container.contains(target)) return
  if (document.activeElement !== target && !target.contains(document.activeElement)) return

  const delta = getEntryFieldRevealDelta(target, container)
  if (Math.abs(delta) < ENTRY_FIELD_REVEAL_THRESHOLD) return
  container.scrollTop += delta
}

function getEntryType(entry: WorldBookEntry): 'trigger' | 'constant' | 'vector' {
  if (entry.constant) return 'constant'
  if (entry.vectorized) return 'vector'
  return 'trigger'
}

function mapSortForApi(sortBy: WorldBookEntrySortBy): 'order' | 'priority' | 'created' | 'updated' | 'name' {
  return sortBy === 'custom' ? 'order' : sortBy
}

export function sortWorldBookEntriesForView(
  entries: WorldBookEntry[],
  sortBy: WorldBookEntrySortBy,
  sortDir: WorldBookEntrySortDir,
): WorldBookEntry[] {
  if (sortBy === 'custom') return entries

  const direction = sortDir === 'desc' ? -1 : 1
  return [...entries].sort((left, right) => {
    let compared = 0
    if (sortBy === 'name') {
      compared = left.comment.localeCompare(right.comment, undefined, { sensitivity: 'base' })
    } else if (sortBy === 'priority') {
      compared = left.priority - right.priority
    } else if (sortBy === 'created') {
      compared = left.created_at - right.created_at
    } else if (sortBy === 'updated') {
      compared = left.updated_at - right.updated_at
    }
    return compared === 0 ? left.id.localeCompare(right.id) : compared * direction
  })
}

function mergeSearchRanges(ranges: EntrySearchTextRange[]): EntrySearchTextRange[] {
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

function HighlightedEntryText({ text, ranges }: { text: string; ranges: EntrySearchTextRange[] }) {
  const safeRanges = mergeSearchRanges(ranges).map((range) => ({
    ...range,
    start: Math.max(0, Math.min(text.length, range.start)),
    end: Math.max(0, Math.min(text.length, range.end)),
  }))
  if (safeRanges.length === 0) return <>{text}</>

  const parts: ReactNode[] = []
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

function searchRangesFor(
  result: EntrySearchResult<WorldBookEntry> | undefined,
  field: 'comment' | 'primaryKey',
  valueIndex = 0,
): EntrySearchTextRange[] {
  return result?.matches
    .filter((match) => match.field === field && match.valueIndex === valueIndex)
    .map((match) => ({ start: match.start, end: match.end, fuzzy: match.fuzzy })) ?? []
}

function useFormatEntryCount() {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entries' })
  return useCallback((count: number) => t('entryCount', { count }), [t])
}

function EntryTokenCell({ bookId, entry, selected }: { bookId: string; entry: WorldBookEntry; selected: boolean }) {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entryEditor' })
  const persistExactCount = useCallback(async (values: Readonly<Record<string, string | number | boolean>>) => {
    for (const [namespace, value] of Object.entries(values)) {
      await worldBooksApi.setEntryExtensionNamespace(bookId, entry.id, namespace, value)
    }
  }, [bookId, entry.id])
  const { count, approximate, status, requestCount, cancel } = useTokenCounts({
    persistExactCount,
    entryId: entry.id,
    content: entry.content,
    extensions: entry.extensions,
  })
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const displayedCount = count ?? estimateTokens(entry.content)
  const displayedApproximate = count == null || approximate

  const clearDwell = useCallback(() => {
    if (dwellTimer.current == null) return
    clearTimeout(dwellTimer.current)
    dwellTimer.current = null
  }, [])
  const schedulePrefetch = useCallback(() => {
    clearDwell()
    dwellTimer.current = setTimeout(() => {
      dwellTimer.current = null
      requestCount()
    }, TOKEN_PREFETCH_DWELL_MS)
  }, [clearDwell, requestCount])

  useEffect(() => {
    if (selected) requestCount()
  }, [requestCount, selected])
  useEffect(() => () => {
    clearDwell()
    cancel()
  }, [cancel, clearDwell])

  return (
    <button
      type="button"
      className={clsx(styles.tokenCell, status === 'counting' && styles.tokenCellCounting)}
      data-world-book-token-cell="true"
      onClick={(event) => {
        event.stopPropagation()
        requestCount()
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={schedulePrefetch}
      onPointerLeave={clearDwell}
      onFocus={schedulePrefetch}
      onBlur={clearDwell}
      disabled={!entry.content.length}
      title={t('countTokensTitle')}
      aria-label={t('tokenCount', { count: displayedCount.toLocaleString() })}
    >
      <FileText size={10} aria-hidden="true" />
      <span>{displayedApproximate ? '~' : ''}{displayedCount.toLocaleString()}</span>
    </button>
  )
}

interface EntryRowProps {
  bookId: string
  editorDensity?: 'default' | 'compact'
  inlineEditor?: boolean
  workspaceMode?: boolean
  workspaceOpen?: boolean
  mobile?: boolean
  showTokens?: boolean
  entry: WorldBookEntry
  expanded: boolean
  dragEnabled: boolean
  selectMode: boolean
  selected: boolean
  searchResult?: EntrySearchResult<WorldBookEntry>
  retainedByFilter?: boolean
  onToggleExpand: () => void
  onToggleSelect: () => void
  onUpdate: (entryId: string, updates: Record<string, any>) => void
  onDebouncedUpdate: (entryId: string, updates: Record<string, any>) => void
  onOpenMenu: (entryId: string, position: ContextMenuPos) => void
  onOpenTypeMenu: (entryId: string, position: ContextMenuPos) => void
  onOpenPositionMenu: (entryId: string, position: ContextMenuPos) => void
  conflict?: EntryEditorConflictState
  onRetryConflict?: () => void
  onUseServerConflict?: () => void
}

interface EntryRowContentProps extends EntryRowProps {
  dragHandleAttributes?: DraggableAttributes
  dragHandleListeners?: Record<string, unknown>
  isDragging?: boolean
}

function EntryRowContent({
  entry,
  bookId,
  editorDensity,
  inlineEditor = true,
  workspaceMode = false,
  workspaceOpen = false,
  mobile = false,
  showTokens = true,
  expanded,
  dragEnabled,
  selectMode,
  selected,
  searchResult,
  retainedByFilter,
  onToggleExpand,
  onToggleSelect,
  onUpdate,
  onDebouncedUpdate,
  onOpenMenu,
  onOpenTypeMenu,
  onOpenPositionMenu,
  conflict,
  onRetryConflict,
  onUseServerConflict,
  dragHandleAttributes,
  dragHandleListeners,
  isDragging,
}: EntryRowContentProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entries' })
  const { t: tEntryFields } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entryEditor.fields' })
  const labels = useWorldBookEntryLabels()
  const { markerLabel } = useLoomOptionLabels()
  const matchedPrimaryKeys = entry.key
    .map((key, index) => ({ key, index, ranges: searchRangesFor(searchResult, 'primaryKey', index) }))
    .filter((value) => value.ranges.length > 0)

  const controlWrapProps = {
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  }

  return (
    <div className={clsx(isDragging && styles.rowDragging)}>
      <div
        className={clsx(
          styles.entryRow,
          expanded && styles.entryRowActive,
          entry.disabled && styles.entryRowDisabled,
          selected && styles.entryRowSelected,
        )}
        data-world-book-entry-row={entry.id}
        data-world-book-entry-revision={entry.revision}
        onClick={selectMode ? onToggleSelect : onToggleExpand}
      >
        <div className={styles.entryHeader}>
          <div className={styles.entryLeading} {...controlWrapProps}>
            {selectMode ? (
              <input
                type="checkbox"
                className={styles.selectionToggle}
                checked={selected}
                onChange={onToggleSelect}
                aria-label={selected ? t('deselect') : t('selectEntry')}
              />
            ) : (
              <input
                type="checkbox"
                className={styles.enableToggle}
                checked={!entry.disabled}
                title={entry.disabled ? t('disabled') : t('enabled')}
                onChange={() => onUpdate(entry.id, { disabled: !entry.disabled })}
                aria-label={entry.disabled ? t('enableEntry') : t('disableEntry')}
              />
            )}
            {dragEnabled && <button
              type="button"
              className={styles.dragHandle}
              title={dragEnabled ? t('dragReorder') : t('dragUnavailable')}
              aria-label={t('dragHandle')}
              tabIndex={-1}
              {...dragHandleAttributes}
              {...dragHandleListeners}
            >
              <GripVertical size={13} />
            </button>}
          </div>

          <div className={styles.entryIdentity}>
              {retainedByFilter && <span className={styles.retainedEntryLabel}>Open entry kept visible while filters are active</span>}
              <span className={styles.entryComment}>
                <HighlightedEntryText
                  text={entry.comment || '(unnamed)'}
                  ranges={entry.comment ? searchRangesFor(searchResult, 'comment') : []}
                />
                {workspaceOpen && <small aria-label="Open in workspace" title="Open in workspace"> · ◦</small>}
                {(entry.folder || entry.tags?.length > 0) && <small title={[entry.folder, ...(entry.tags ?? [])].filter(Boolean).join(' · ')}> · {[entry.folder, ...(entry.tags ?? [])].filter(Boolean).join(' · ')}</small>}
              </span>
              <div className={styles.entryMeta}>
                {mobile ? <span className={styles.entryMetaItem}>{labels.entryTypeLabel(entry)} · {labels.positionLabel(entry.position)}</span> : <>
                <button
                  type="button"
                  className={clsx(
                    styles.typeBadgeBtn,
                    styles.entryBadge,
                    entry.constant ? styles.badgeConstant : entry.vectorized ? styles.badgeVector : styles.badgeTrigger,
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    const rect = e.currentTarget.getBoundingClientRect()
                    onOpenTypeMenu(entry.id, { x: rect.right, y: rect.bottom + 4 })
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  title={t('changeEntryType')}
                  aria-label={t('changeEntryTypeFrom', { type: getEntryType(entry) })}
                >
                  <span>{labels.entryTypeLabel(entry)}</span>
                  <ChevronDown size={11} />
                </button>
                <button
                  type="button"
                  className={clsx(styles.positionBadgeBtn, styles.entryMetaItem)}
                  onClick={(e) => {
                    e.stopPropagation()
                    const rect = e.currentTarget.getBoundingClientRect()
                    onOpenPositionMenu(entry.id, { x: rect.right, y: rect.bottom + 4 })
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  title={t('changeEntryPosition')}
                  aria-label={t('changeEntryPositionFrom', { position: labels.positionLabel(entry.position) })}
                >
                  <span>{entry.position === 7 && entry.wi_marker ? `${labels.positionLabel(entry.position)} · ${markerLabel(entry.wi_marker)}` : labels.positionLabel(entry.position)}</span>
                  <ChevronDown size={11} />
                </button>
                </>}
                <span
                  className={clsx(styles.entryMetaItem, styles.orderBadge)}
                  title={`${tEntryFields('order')}: ${entry.order_value.toLocaleString()}`}
                  {...controlWrapProps}
                >
                  <Hash size={10} aria-hidden="true" />
                  <span>{entry.order_value.toLocaleString()}</span>
                </span>
                {showTokens && <EntryTokenCell bookId={bookId} entry={entry} selected={selected || expanded} />}
              </div>
              {matchedPrimaryKeys.length > 0 && (
                <div className={styles.entrySearchContext}>
                  <b>Key</b>
                  <span>
                    {matchedPrimaryKeys.map(({ key, index, ranges }, matchIndex) => (
                      <span key={`${index}:${key}`}>
                        {matchIndex > 0 && ', '}
                        <HighlightedEntryText text={key} ranges={ranges} />
                      </span>
                    ))}
                  </span>
                </div>
              )}
              {searchResult?.snippet && (
                <div className={styles.entrySearchContext}>
                  <b>{searchResult.snippet.label}</b>
                  <span>
                    {searchResult.snippet.leadingEllipsis && '…'}
                    <HighlightedEntryText text={searchResult.snippet.text} ranges={searchResult.snippet.ranges} />
                    {searchResult.snippet.trailingEllipsis && '…'}
                  </span>
                </div>
              )}
            </div>

            <div className={styles.entryActions} {...controlWrapProps}>
            <button
              type="button"
              className={styles.expandBtn}
              onClick={onToggleExpand}
              title={workspaceMode ? 'Open entry editor' : expanded ? t('collapseEditor') : t('expandEditor')}
              aria-label={workspaceMode ? 'Open entry editor' : expanded ? t('collapseEditor') : t('expandEditor')}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span>{workspaceMode ? expanded ? 'Active' : 'Open' : expanded ? t('collapse') : t('expand')}</span>
            </button>
            <button
              type="button"
              className={styles.moreBtn}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                onOpenMenu(entry.id, { x: rect.right, y: rect.bottom + 4 })
              }}
              title={t('moreActions')}
            >
              <MoreVertical size={13} />
            </button>
          </div>
        </div>

      </div>

      {expanded && inlineEditor && (
        <WorldBookEntryEditor
          density={editorDensity}
          scrollMode="parent"
          entry={entry}
          onUpdate={onDebouncedUpdate}
          onImmediateUpdate={onUpdate}
          conflict={conflict}
          onRetryConflict={onRetryConflict}
          onUseServerConflict={onUseServerConflict}
        />
      )}
    </div>
  )
}

function SortableEntryRow(props: EntryRowProps) {
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({
    id: props.entry.id,
    disabled: !props.dragEnabled,
  })
  const { setNodeRef, style } = useScaledSortableStyle({
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  })

  return (
    <div ref={setNodeRef} style={style}>
      <EntryRowContent
        {...props}
        dragHandleAttributes={attributes}
        dragHandleListeners={listeners}
        isDragging={isDragging}
      />
    </div>
  )
}

function EntryRow(props: EntryRowProps) {
  if (!props.dragEnabled) {
    return <EntryRowContent {...props} />
  }

  return <SortableEntryRow {...props} />
}

interface MoveCopyModalState {
  mode: 'move' | 'copy'
  entryIds: string[]
  title: string
  confirmText: string
}

interface DeleteState {
  entryIds: string[]
  title: string
  message: string
}

interface RenumberState {
  entryIds: string[]
}

interface KeywordState {
  entryIds: string[]
}

interface ActivationState {
  entryIds: string[]
}

interface EntryIntent {
  updates: Record<string, any>
  version: number
}

interface WorldBookEntriesSectionProps {
  active?: boolean
  onEntryCount?: (count: number) => void
  onDetailViewChange?: (editing: boolean) => void
  presentation?: 'workspace' | 'navigation'
  onOpenEntry?: (entryId: string) => void
  books: WorldBook[]
  selectedBookId: string
  editorDensity?: 'default' | 'compact'
  onRefreshVectorSummary?: (bookId: string) => Promise<void> | void
  scrollContainerRef?: { current: HTMLDivElement | null }
  paginationContainer?: HTMLDivElement | null
}

export default function WorldBookEntriesSection({
  presentation,
  active = true,
  onEntryCount,
  onDetailViewChange,
  onOpenEntry,
  books,
  selectedBookId,
  editorDensity,
  onRefreshVectorSummary,
  scrollContainerRef,
  paginationContainer,
}: WorldBookEntriesSectionProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel' })
  const { t: te } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entries' })
  const { t: tc } = useTranslation('common')
  const labels = useWorldBookEntryLabels()
  const formatEntryCount = useFormatEntryCount()
  const worldBookEntryViewPrefs = useStore((s) => s.worldBookEntryViewPrefs)
  const pendingWorldBookEditEntryId = useStore((s) => s.pendingWorldBookEditEntryId)
  const setPendingWorldBookEditEntryId = useStore((s) => s.setPendingWorldBookEditEntryId)
  const setSetting = useStore((s) => s.setSetting)
  const isMobile = useIsMobile()
  const [showTokens, setShowTokens] = useState(true)
  const listViewportRef = useRef<HTMLDivElement>(null)
  const savedListScroll = useRef(0)
  const detailViewportRef = useRef<HTMLElement>(null)
  const detailBackRef = useRef<HTMLButtonElement>(null)
  const navigatorToggleRef = useRef<HTMLButtonElement>(null)
  const workspaceSwitcherRef = useRef<HTMLButtonElement>(null)

  const { entries, cached: workspaceEntries, openIds, setEntries, open: openWorkspaceEntry, close: closeWorkspaceEntry } = useEntryWorkspace()
  const allKnownEntries = useMemo(() => [...entries, ...workspaceEntries.filter(entry => !entries.some(value => value.id === entry.id))], [entries, workspaceEntries])
  const [navigatorCollapsed, setNavigatorCollapsed] = useState(false)
  const [navigatorWidth, setNavigatorWidth] = useState(300)
  const [mobileBrowsing, setMobileBrowsing] = useState(false)
  const [openSwitcher, setOpenSwitcher] = useState(false)
  const [splitEntryId, setSplitEntryId] = useState<string | null>(null)
  const [sourceEntryTotal, setSourceEntryTotal] = useState(0)
  const [entryFolder, setEntryFolder] = useState<string | undefined>()
  const [entryTags, setEntryTags] = useState<string[]>([])
  const [folderRoot, setFolderRoot] = useState(!pendingWorldBookEditEntryId)
  const [organization, setOrganization] = useState<WorldBookEntryOrganizationSummary | null>(null)
  const showFolderRoot = folderRoot && !!organization?.folders.length
  const [entriesError, setEntriesError] = useState('')
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [entryPage, setEntryPage] = useState(1)
  const [loadingEntries, setLoadingEntries] = useState(false)
  const [entrySearchFilter, setEntrySearchFilter] = useState('')
  const [entryTypeFilter, setEntryTypeFilter] = useState<'all' | 'trigger' | 'constant' | 'vector'>('all')
  const [entrySortBy, setEntrySortBy] = useState<WorldBookEntrySortBy>('custom')
  const [entrySortDir, setEntrySortDir] = useState<WorldBookEntrySortDir>('asc')
  const [entryPageSize, setEntryPageSize] = useState<WorldBookEntryPageSize>(DEFAULT_PAGE_SIZE)
  const [mobileListOptionsOpen, setMobileListOptionsOpen] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [contextMenu, setContextMenu] = useState<{ entryId: string; position: ContextMenuPos } | null>(null)
  const [typeMenu, setTypeMenu] = useState<{ entryId: string; position: ContextMenuPos } | null>(null)
  const [positionMenu, setPositionMenu] = useState<{ entryId: string; position: ContextMenuPos } | null>(null)
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null)
  const [moveCopyState, setMoveCopyState] = useState<MoveCopyModalState | null>(null)
  const [renumberState, setRenumberState] = useState<RenumberState | null>(null)
  const [keywordState, setKeywordState] = useState<KeywordState | null>(null)
  const [activationState, setActivationState] = useState<ActivationState | null>(null)
  const [bulkActionsMenu, setBulkActionsMenu] = useState<ContextMenuPos | null>(null)
  const [moveTargetBookId, setMoveTargetBookId] = useState('')
  const organizationControlsRef = useRef<EntryOrganizationHandle>(null)
  const bulkActionsTriggerRef = useRef<HTMLButtonElement>(null)
  const [renumberStart, setRenumberStart] = useState('')
  const [renumberStep, setRenumberStep] = useState('1')
  const [renumberDirection, setRenumberDirection] = useState<'asc' | 'desc'>('asc')
  const [keywordValue, setKeywordValue] = useState('')
  const [keywordTarget, setKeywordTarget] = useState<'primary' | 'secondary'>('primary')
  const [bulkActivation, setBulkActivation] = useState<'trigger' | 'constant' | 'vector'>('trigger')
  const [positionState, setPositionState] = useState<{ entryIds: string[] } | null>(null)
  const [bulkPosition, setBulkPosition] = useState(0)
  const [bulkDepth, setBulkDepth] = useState('4')
  const [showTokenReport, setShowTokenReport] = useState(false)
  const [pendingAction, setPendingAction] = useState(false)
  const [entryConflicts, setEntryConflicts] = useState<Record<string, EntryEditorConflictState>>({})
  const entryIntentsRef = useRef<Map<string, EntryIntent>>(new Map())
  const retryOperationsRef = useRef<Map<string, () => Promise<void>>>(new Map())
  const mountedRef = useRef(false)
  const selectedBookIdRef = useRef(selectedBookId)
  const requestGenerationRef = useRef(0)
  const entriesAbortRef = useRef<AbortController | null>(null)
  const loadedSearchScopeRef = useRef<string | null>(null)
  const entryTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const sectionRef = useRef<HTMLDivElement>(null)
  const entrySearchInputRef = useRef<HTMLInputElement>(null)
  const entrySearchIndex = useMemo(() => createEntrySearchIndex(), [])
  const entryListRef = useRef<HTMLDivElement>(null)
  const localScrollRef = useRef<HTMLDivElement>(null)
  const focusedEntryFieldRef = useRef<HTMLElement | null>(null)
  const focusRevealFrameRef = useRef(0)
  const focusRevealTimersRef = useRef<number[]>([])
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const activeScrollRef = presentation === 'workspace' ? selectedEntryId && isMobile && !mobileBrowsing ? detailViewportRef : listViewportRef : scrollContainerRef ?? localScrollRef
  const usesSharedScroll = scrollContainerRef != null
  useScrollGate(activeScrollRef)

  const clearEntryTimers = useCallback(() => {
    for (const timer of Object.values(entryTimers.current)) clearTimeout(timer)
    entryTimers.current = {}
  }, [])

  useEffect(() => {
    mountedRef.current = true
    const retryOperations = retryOperationsRef.current
    const entryIntents = entryIntentsRef.current
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
      entriesAbortRef.current?.abort()
      clearEntryTimers()
      clearTimeout(liveRefetchTimer.current)
      retryOperations.clear()
      entryIntents.clear()
    }
  }, [clearEntryTimers])

  useEffect(() => {
    selectedBookIdRef.current = selectedBookId
    requestGenerationRef.current += 1
    entriesAbortRef.current?.abort()
    clearEntryTimers()
    retryOperationsRef.current.clear()
    entryIntentsRef.current.clear()
    setEntryConflicts({})
  }, [clearEntryTimers, selectedBookId])

  const clearFocusRevealTimers = useCallback(() => {
    for (const timer of focusRevealTimersRef.current) {
      window.clearTimeout(timer)
    }
    focusRevealTimersRef.current = []
  }, [])

  const scheduleEntryFieldReveal = useCallback((target = focusedEntryFieldRef.current) => {
    if (typeof window === 'undefined' || navigator.maxTouchPoints <= 0) return
    if (!target) return

    if (focusRevealFrameRef.current) {
      window.cancelAnimationFrame(focusRevealFrameRef.current)
    }
    focusRevealFrameRef.current = window.requestAnimationFrame(() => {
      focusRevealFrameRef.current = 0
      revealEntryFieldTarget(target, activeScrollRef.current)
    })
  }, [activeScrollRef])

  const scheduleEntryFieldFocusCorrection = useCallback((target: HTMLElement) => {
    focusedEntryFieldRef.current = target
    clearFocusRevealTimers()

    // Chromium/Android PWAs opt into `interactive-widget=resizes-content`, so
    // the browser has already resized the layout viewport above the keyboard.
    // Wait until that resize settles, then perform at most one minimal fallback
    // correction. Running the immediate + multi-timer path here counts the
    // keyboard twice and visibly throws the lorebook panel upward.
    if (usesBrowserResizedKeyboardViewport()) {
      focusRevealTimersRef.current = [window.setTimeout(
        () => scheduleEntryFieldReveal(target),
        ENTRY_FIELD_RESIZED_VIEWPORT_SETTLE_DELAY,
      )]
      return
    }

    scheduleEntryFieldReveal(target)
    focusRevealTimersRef.current = ENTRY_FIELD_FOCUS_SETTLE_DELAYS.map((delay) =>
      window.setTimeout(() => scheduleEntryFieldReveal(target), delay)
    )
  }, [clearFocusRevealTimers, scheduleEntryFieldReveal])

  useEffect(() => {
    if (typeof window === 'undefined' || navigator.maxTouchPoints <= 0) return
    const root = sectionRef.current
    if (!root) return

    const handleFocusIn = (event: FocusEvent) => {
      if (!isEditableEntryField(event.target)) return
      scheduleEntryFieldFocusCorrection(event.target)
    }

    const handleFocusOut = (event: FocusEvent) => {
      if (event.target === focusedEntryFieldRef.current) {
        focusedEntryFieldRef.current = null
      }
    }

    const handleInput = (event: Event) => {
      if (!isEditableEntryField(event.target)) return
      focusedEntryFieldRef.current = event.target
      if (usesBrowserResizedKeyboardViewport()) return
      scheduleEntryFieldReveal(event.target)
    }

    const handleViewportChange = () => {
      const target = focusedEntryFieldRef.current
      if (!target) return
      if (usesBrowserResizedKeyboardViewport()) {
        scheduleEntryFieldFocusCorrection(target)
      } else {
        scheduleEntryFieldReveal(target)
      }
    }

    root.addEventListener('focusin', handleFocusIn)
    root.addEventListener('focusout', handleFocusOut)
    root.addEventListener('input', handleInput)
    window.visualViewport?.addEventListener('resize', handleViewportChange)
    window.visualViewport?.addEventListener('scroll', handleViewportChange)

    return () => {
      root.removeEventListener('focusin', handleFocusIn)
      root.removeEventListener('focusout', handleFocusOut)
      root.removeEventListener('input', handleInput)
      window.visualViewport?.removeEventListener('resize', handleViewportChange)
      window.visualViewport?.removeEventListener('scroll', handleViewportChange)
      clearFocusRevealTimers()
      if (focusRevealFrameRef.current) {
        window.cancelAnimationFrame(focusRevealFrameRef.current)
        focusRevealFrameRef.current = 0
      }
    }
  }, [clearFocusRevealTimers, scheduleEntryFieldFocusCorrection, scheduleEntryFieldReveal])

  // ── Live-sync (WORLD_BOOK_ENTRY_* / WORLD_BOOK_CHANGED) ──
  // Mirror of `entries` for use inside WS handlers without re-subscribing.
  const entriesRef = useRef<WorldBookEntry[]>(entries)
  useEffect(() => { entriesRef.current = allKnownEntries }, [allKnownEntries])
  // entryId → timestamp of the last local write; used to ignore our own echoes.
  const recentLocalWrites = useRef<Map<string, number>>(new Map())
  // Always-current silent refetch of the visible page, called from WS handlers.
  const liveRefetchRef = useRef<() => void>(() => {})
  const liveRefetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const pageSize = entryPageSize === 'all' ? DEFAULT_PAGE_SIZE : entryPageSize
  // Search ranks the complete organization/type scope before slicing a page.
  // Ordinary browsing keeps its server pagination and selected sort.
  const searchCorpusMode = entrySearchFilter.trim().length > 0
  const entrySearchResults = useMemo(
    () => searchEntriesByQuery(entries, entrySearchFilter, entrySearchIndex),
    [entries, entrySearchFilter, entrySearchIndex],
  )
  const searchActive = entrySearchResults !== null
  const queryEntries = useMemo(
    () => entrySearchResults?.map((result) => result.entry) ?? entries,
    [entrySearchResults, entries],
  )
  const typeCounts = useMemo(() => {
    const counts = { trigger: 0, constant: 0, vector: 0 }
    for (const entry of queryEntries) counts[getEntryType(entry)] += 1
    return counts
  }, [queryEntries])
  const filteredEntries = useMemo(
    () => searchCorpusMode
      ? queryEntries.slice((entryPage - 1) * pageSize, entryPage * pageSize)
      : queryEntries,
    [searchCorpusMode, queryEntries, entryPage, pageSize],
  )
  const entryTotal = searchCorpusMode ? queryEntries.length : sourceEntryTotal
  const entryTotalPages = pageSize ? Math.max(1, Math.ceil(entryTotal / pageSize)) : 1
  const visibleEntries = filteredEntries
  useTokenCountSweep(showTokens ? visibleEntries : [])
  const entrySearchResultsById = useMemo(
    () => new Map(entrySearchResults?.map((result) => [result.entry.id, result]) ?? []),
    [entrySearchResults],
  )
  const retainedSelectedEntry = useMemo(() => {
    if (presentation === 'workspace' || (!searchActive && entryTypeFilter === 'all') || !selectedEntryId) return null
    if (visibleEntries.some((entry) => entry.id === selectedEntryId)) return null
    return entries.find((entry) => entry.id === selectedEntryId) ?? null
  }, [entries, entryTypeFilter, searchActive, selectedEntryId, visibleEntries, presentation])
  const renderedEntries = useMemo(
    () => retainedSelectedEntry ? [...visibleEntries, retainedSelectedEntry] : visibleEntries,
    [retainedSelectedEntry, visibleEntries],
  )
  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? null,
    [books, selectedBookId],
  )
  const availableTargetBooks = useMemo(
    () =>
      books
        .filter((book) => book.id !== selectedBookId)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map((book) => ({ value: book.id, label: book.name, group: book.folder || undefined })),
    [books, selectedBookId],
  )
  const currentSortLabel = useMemo(
    () => labels.sortOptions.find((option) => option.value === entrySortBy)?.label ?? entrySortBy,
    [entrySortBy, labels.sortOptions],
  )
  const currentPageSizeLabel = useMemo(
    () => labels.pageSizeOptions.find((option) => String(option.value) === String(entryPageSize))?.label ?? String(entryPageSize),
    [entryPageSize, labels.pageSizeOptions],
  )
  const mobileListOptionsSummary = useMemo(
    () => `${currentSortLabel} | ${currentPageSizeLabel}`,
    [currentPageSizeLabel, currentSortLabel],
  )
  const allSelected = filteredEntries.length > 0 && selectedIds.length === filteredEntries.length
  const selectedCount = selectedIds.length
  const expectedRevisionsFor = useCallback((entryIds: string[]) => (
    Object.fromEntries(
      entryIds
        .map((id) => entriesRef.current.find((entry) => entry.id === id))
        .filter((entry): entry is WorldBookEntry => Boolean(entry))
        .map((entry) => [entry.id, entry.revision]),
    )
  ), [])
  const recordMutationIssue = useCallback((
    entryIds: string[],
    error: unknown,
    retry: () => Promise<void>,
    bookId: string,
    generation: number,
  ) => {
    const issue: WorldBookEntryMutationIssue | null = classifyWorldBookEntryMutationError(error)
    if (!issue || !mountedRef.current || selectedBookIdRef.current !== bookId || requestGenerationRef.current !== generation) return false
    const currentById = issue.kind === 'conflict'
      ? new Map(issue.payload.conflicts.map((conflict) => [conflict.id, conflict.current]))
      : new Map<string, WorldBookEntry | null>()
    const affectedIds = issue.kind === 'conflict' && issue.payload.conflicts.length > 0
      ? issue.payload.conflicts.map((conflict) => conflict.id)
      : entryIds
    setEntries((current) => current.map((entry) => {
      const server = currentById.get(entry.id)
      if (!server) return entry
      return { ...entry, revision: server.revision }
    }))
    setEntryConflicts((current) => {
      const next = { ...current }
      for (const id of affectedIds) {
        const server = currentById.get(id)
        next[id] = issue.kind === 'conflict'
          ? { kind: 'conflict', current: server ?? null }
          : { kind: 'malformed-precondition', message: issue.payload.message }
        retryOperationsRef.current.set(id, retry)
      }
      return next
    })
    setSelectedEntryId((current) => current ?? affectedIds[0] ?? null)
    return true
  }, [setEntries])

  const retryConflict = useCallback((entryId: string) => {
    const retry = retryOperationsRef.current.get(entryId)
    if (!retry) return
    const bookId = selectedBookIdRef.current
    const generation = requestGenerationRef.current
    const operationIds = Array.from(retryOperationsRef.current.entries())
      .filter(([, operation]) => operation === retry)
      .map(([id]) => id)
    setEntryConflicts((current) => {
      const next = { ...current }
      for (const id of operationIds) delete next[id]
      return next
    })
    void retry().then(() => {
      for (const id of operationIds) {
        if (retryOperationsRef.current.get(id) === retry) retryOperationsRef.current.delete(id)
      }
    }).catch((error) => {
      const classified = recordMutationIssue(operationIds, error, retry, bookId, generation)
      if (!classified) liveRefetchRef.current()
    })
  }, [recordMutationIssue])

  const acceptServerConflict = useCallback((entryId: string) => {
    const conflict = entryConflicts[entryId]
    const server = conflict?.current
    if (server) {
      setEntries((current) => current.map((entry) => (entry.id === entryId ? server : entry)))
    } else if (conflict?.kind === 'conflict') {
      setEntries((current) => current.filter((entry) => entry.id !== entryId))
    }
    entryIntentsRef.current.delete(entryId)
    retryOperationsRef.current.delete(entryId)
    setEntryConflicts((current) => {
      const next = { ...current }
      delete next[entryId]
      return next
    })
  }, [entryConflicts, setEntries])
  const dragUnavailableReason = useMemo(() => {
    if (entrySortBy !== 'custom') return null
    if (entrySearchFilter.trim()) return te('clearSearchDrag')
    if (entryTypeFilter !== 'all') return 'Show all entry types to drag-reorder entries.'
    if (entryFolder !== undefined || entryTags.length) return 'Show all entries without folder or tag filters to drag-reorder entries.'
    if (sourceEntryTotal !== entries.length) return 'Choose a page size that shows the entire lorebook to drag-reorder entries.'
    return null
  }, [entrySortBy, entrySearchFilter, entryTypeFilter, entryFolder, entryTags, sourceEntryTotal, entries.length, te])
  const dragEnabled = entrySortBy === 'custom' && !dragUnavailableReason

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const persistViewPref = useCallback((bookId: string, pref: {
    sortBy: WorldBookEntrySortBy
    sortDir: WorldBookEntrySortDir
    pageSize: WorldBookEntryPageSize
  }) => {
    setSetting('worldBookEntryViewPrefs', {
      ...worldBookEntryViewPrefs,
      [bookId]: pref,
    })
  }, [setSetting, worldBookEntryViewPrefs])

  const refreshVectorSummary = useCallback(async () => {
    if (!selectedBookId || !onRefreshVectorSummary) return
    await onRefreshVectorSummary(selectedBookId)
  }, [onRefreshVectorSummary, selectedBookId])

  const loadEntries = useCallback(async (
    bookId: string,
    opts?: { silent?: boolean; force?: boolean },
  ) => {
    const searchScope = JSON.stringify([bookId, entryFolder, entryTags, entryTypeFilter])
    if (searchCorpusMode && !opts?.force && loadedSearchScopeRef.current === searchScope) return
    loadedSearchScopeRef.current = null

    const requestGeneration = requestGenerationRef.current
    const isCurrent = () => mountedRef.current && selectedBookIdRef.current === bookId && requestGenerationRef.current === requestGeneration
    const silent = opts?.silent ?? false
    entriesAbortRef.current?.abort()
    const controller = new AbortController()
    entriesAbortRef.current = controller
    if (!silent && isCurrent()) setLoadingEntries(true)
    try {
      const paginatedPageSize = entryPageSize === 'all' ? DEFAULT_PAGE_SIZE : entryPageSize
      const [res, summary] = await Promise.all([searchCorpusMode
        ? loadLorebookSearchEntries(pagination => worldBooksApi.listEntries(bookId, {
            ...pagination,
            sort_by: 'order',
            sort_dir: 'asc',
            folder: entryFolder,
            tag: entryTags,
            type: entryTypeFilter === 'all' ? undefined : entryTypeFilter,
          }, { signal: controller.signal }), controller.signal).then(data => ({ data, total: data.length }))
        : worldBooksApi.listEntries(bookId, {
            limit: paginatedPageSize,
            offset: (entryPage - 1) * paginatedPageSize,
            sort_by: mapSortForApi(entrySortBy),
            sort_dir: entrySortBy === 'custom' ? 'asc' : entrySortDir,
            folder: entryFolder,
            tag: entryTags,
            type: entryTypeFilter === 'all' ? undefined : entryTypeFilter,
          }, { signal: controller.signal }), worldBooksApi.getEntryOrganization(bookId)])
      let nextEntries = res.data
      const pendingEntryId = active ? useStore.getState().pendingWorldBookEditEntryId : null
      if (pendingEntryId && !nextEntries.some((entry) => entry.id === pendingEntryId)) {
        try {
          const pendingEntry = await worldBooksApi.getEntry(bookId, pendingEntryId)
          nextEntries = [pendingEntry, ...nextEntries]
        } catch {
          if (isCurrent()) useStore.getState().setPendingWorldBookEditEntryId(null)
        }
      }
      if (!isCurrent() || controller.signal.aborted || entriesAbortRef.current !== controller) { if (opts?.force) throw new Error('Reload superseded'); return }
      setEntries(nextEntries)
      setSourceEntryTotal(res.total)
      loadedSearchScopeRef.current = searchCorpusMode ? searchScope : null
      setOrganization(summary)
      setEntriesError('')
      if (!searchCorpusMode && (entryPage - 1) * paginatedPageSize >= res.total) setEntryPage(Math.max(1, Math.ceil(res.total / paginatedPageSize)))
    } catch (error) {
      if (!controller.signal.aborted) { if (isCurrent() && entriesAbortRef.current === controller) setEntriesError('Could not load entries. Retry Refresh.'); throw error }
      if (opts?.force) throw error
    } finally {
      const ownsRequest = entriesAbortRef.current === controller
      if (ownsRequest) entriesAbortRef.current = null
      if (!silent && ownsRequest && isCurrent()) setLoadingEntries(false)
    }
  }, [entryFolder, entryTags, searchCorpusMode, entryTypeFilter, entryPage, entryPageSize, entrySortBy, entrySortDir, active, setEntries])

  const selectedBookViewPreference = worldBookEntryViewPrefs[selectedBookId]
  const resolvedSelectedBookViewPreference = useMemo(
    () => resolveWorldBookEntryViewPreference(selectedBookViewPreference),
    [selectedBookViewPreference],
  )

  useEffect(() => {
    const pref = resolvedSelectedBookViewPreference
    setEntrySortBy(pref.sortBy)
    setEntrySortDir(pref.sortDir)
    setEntryPageSize(pref.pageSize === 'all' ? DEFAULT_PAGE_SIZE : pref.pageSize || DEFAULT_PAGE_SIZE)
  }, [selectedBookId, resolvedSelectedBookViewPreference])

  useEffect(() => {
    const reset = getWorldBookEntriesSectionBookResetState()
    setEntryFolder(undefined); setEntryTags(current => current.length ? [] : current); setOrganization(null)
    setFolderRoot(!useStore.getState().pendingWorldBookEditEntryId)
    setEntryPage(reset.entryPage)
    setEntrySearchFilter(reset.entrySearchFilter)
    setEntryTypeFilter(reset.entryTypeFilter)
    setMobileListOptionsOpen(reset.mobileListOptionsOpen)
    setSelectedEntryId(reset.selectedEntryId)
    setShowTokenReport(reset.showTokenReport)
    setSelectMode(reset.selectMode)
    setSelectedIds(reset.selectedIds)
    setContextMenu(reset.contextMenu)
    setTypeMenu(reset.typeMenu)
    setPositionMenu(reset.positionMenu)
    setBulkActionsMenu(reset.bulkActionsMenu)
    setActivationState(reset.activationState)
  }, [selectedBookId])

  useEffect(() => {
    if (!selectedBookId) return
    void loadEntries(selectedBookId).catch(() => {})
  }, [selectedBookId, loadEntries])

  // Keep the silent-refetch closure current so the WS subscription (bound once
  // per book) refetches the current server page or complete search scope.
  useEffect(() => {
    liveRefetchRef.current = () => {
      if (!selectedBookId) return
      void loadEntries(selectedBookId, { silent: true, force: true })
    }
  }, [loadEntries, selectedBookId])

  const scheduleLiveRefetch = useCallback(() => {
    clearTimeout(liveRefetchTimer.current)
    liveRefetchTimer.current = setTimeout(() => liveRefetchRef.current(), 250)
  }, [])

  // Reflect world-book changes made elsewhere (another tab/device, or a Spindle
  // extension) into the open editor. WORLD_BOOK_ENTRY_CHANGED carries the full
  // entry, so a visible entry is patched in place — safe because the entry editor
  // keeps edited text in id-keyed local state and won't re-sync a same-id patch.
  // Unknown entries (newly created / on another page) and structural book changes
  // (reorder, bulk ops) trigger a silent refetch of the visible page instead.
  useEffect(() => {
    if (!selectedBookId) return
    const isSelfEcho = (id: string) => {
      const ts = recentLocalWrites.current.get(id)
      if (ts == null) return false
      if (Date.now() - ts > SELF_ECHO_WINDOW_MS) {
        recentLocalWrites.current.delete(id)
        return false
      }
      return true
    }
    const offEntryChanged = wsClient.on(EventType.WORLD_BOOK_ENTRY_CHANGED, (p: WorldBookEntryChangedPayload) => {
      if (!p?.entry || p.worldBookId !== selectedBookId || isSelfEcho(p.id)) return
      invalidateTokenCountsForEntry(p.id)
      if (!entriesRef.current.some((e) => e.id === p.id)) {
        scheduleLiveRefetch()
        return
      }
      setEntries((cur) => cur.map((e) => (e.id === p.id ? p.entry : e)))
      scheduleLiveRefetch()
    })
    const offEntryDeleted = wsClient.on(EventType.WORLD_BOOK_ENTRY_DELETED, (p: WorldBookEntryDeletedPayload) => {
      if (!p?.id || p.worldBookId !== selectedBookId) return
      invalidateTokenCountsForEntry(p.id)
      if (entriesRef.current.some((e) => e.id === p.id)) {
        setEntries((cur) => cur.filter((e) => e.id !== p.id))
        setSelectedEntryId((cur) => (cur === p.id ? null : cur))
        setSelectedIds((cur) => cur.filter((id) => id !== p.id))
      }
      // A server-paginated view does not hold enough rows to repair its total
      // or backfill the page after a deletion, including one on another page.
      scheduleLiveRefetch()
    })
    const offBookChanged = wsClient.on(EventType.WORLD_BOOK_CHANGED, (p: WorldBookChangedPayload) => {
      if (p?.id !== selectedBookId) return
      scheduleLiveRefetch()
    })
    return () => {
      offEntryChanged()
      offEntryDeleted()
      offBookChanged()
      clearTimeout(liveRefetchTimer.current)
    }
  }, [selectedBookId, scheduleLiveRefetch, setEntries])

  useEffect(() => {
    const visibleIds = new Set(filteredEntries.map((entry) => entry.id))
    setSelectedIds((current) => current.filter((id) => visibleIds.has(id)))
  }, [filteredEntries])

  useEffect(() => {
    if (entryPage > entryTotalPages) setEntryPage(entryTotalPages)
  }, [entryPage, entryTotalPages])

  useEffect(() => {
    if (!active || !pendingWorldBookEditEntryId) return
    const targetIndex = filteredEntries.findIndex((entry) => entry.id === pendingWorldBookEditEntryId)
    if (targetIndex < 0) return
    setSelectedEntryId(pendingWorldBookEditEntryId)
    setPendingWorldBookEditEntryId(null)
  }, [filteredEntries, pendingWorldBookEditEntryId, setPendingWorldBookEditEntryId, active])

  useEffect(() => {
    if (!selectedEntryId) return
    if (presentation === 'workspace') { if (isMobile && !mobileBrowsing) detailBackRef.current?.focus(); return }
    const element = entryListRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(selectedEntryId)}"]`)
    element?.scrollIntoView({ block: 'nearest' })
  }, [entryPage, selectedEntryId, presentation, isMobile, mobileBrowsing])

  useEffect(() => {
    if (presentation === 'workspace' && selectedEntryId) openWorkspaceEntry(selectedEntryId)
  }, [selectedEntryId, entries, presentation, openWorkspaceEntry])
  useEffect(() => { setMobileBrowsing(false) }, [selectedEntryId])
  useEffect(() => { if (splitEntryId && !openIds.includes(splitEntryId)) setSplitEntryId(null) }, [openIds, splitEntryId])

  useEffect(() => { if (organization) onEntryCount?.(organization.total) }, [organization, onEntryCount])
  useEffect(() => {
    if (organization && !organization.folders.length && entryFolder !== undefined) {
      setEntryFolder(undefined)
      setEntryPage(1)
      setSelectedIds([])
    }
  }, [organization, entryFolder])

  const refetchCurrentPage = useCallback(async () => {
    await loadEntries(selectedBookId, { force: true })
  }, [selectedBookId, loadEntries])

  const persistEntryUpdate = useCallback(async (entryId: string, intent: EntryIntent) => {
    const generation = requestGenerationRef.current
    const expected_revision = entriesRef.current.find((entry) => entry.id === entryId)?.revision
    try {
      const updated = await worldBooksApi.updateEntry(selectedBookId, entryId, {
        ...intent.updates,
        ...(expected_revision === undefined ? {} : { expected_revision }),
      })
      if (!mountedRef.current || selectedBookIdRef.current !== selectedBookId || requestGenerationRef.current !== generation) return
      if (entryIntentsRef.current.get(entryId) !== intent) {
        setEntries((current) => current.map((entry) => (
          entry.id === entryId ? { ...entry, revision: updated.revision } : entry
        )))
        return
      }
      entryIntentsRef.current.delete(entryId)
      setEntryConflicts((current) => {
        const next = { ...current }
        delete next[entryId]
        return next
      })
      if (Object.prototype.hasOwnProperty.call(intent.updates, 'content')) invalidateTokenCountsForEntry(entryId)
      setEntries((current) => current.map((entry) => (entry.id === entryId ? updated : entry)))
      if (intent.updates.folder !== undefined || intent.updates.tags !== undefined) await refetchCurrentPage()
      else await refreshVectorSummary()
    } catch (error) {
      if (!mountedRef.current || selectedBookIdRef.current !== selectedBookId || requestGenerationRef.current !== generation) return
      if (entryIntentsRef.current.get(entryId) !== intent) return
      const classified = recordMutationIssue([entryId], error, () => persistEntryUpdate(entryId, intent), selectedBookId, generation)
      if (!classified) void refetchCurrentPage()
    }
  }, [recordMutationIssue, refetchCurrentPage, refreshVectorSummary, selectedBookId, setEntries])

  const updateEntry = useCallback((entryId: string, updates: Record<string, any>) => {
    if (Object.prototype.hasOwnProperty.call(updates, 'content')) invalidateTokenCountsForEntry(entryId)
    const previous = entryIntentsRef.current.get(entryId)
    const intent: EntryIntent = {
      updates: { ...previous?.updates, ...updates },
      version: (previous?.version ?? 0) + 1,
    }
    entryIntentsRef.current.set(entryId, intent)
    setEntries((current) => current.map((entry) => (entry.id === entryId ? { ...entry, ...updates } : entry)))
    recentLocalWrites.current.set(entryId, Date.now())
    void persistEntryUpdate(entryId, intent)
  }, [persistEntryUpdate, setEntries])

  const debouncedUpdateEntry = useCallback((entryId: string, updates: Record<string, any>) => {
    if (Object.prototype.hasOwnProperty.call(updates, 'content')) invalidateTokenCountsForEntry(entryId)
    const previous = entryIntentsRef.current.get(entryId)
    const intent: EntryIntent = {
      updates: { ...previous?.updates, ...updates },
      version: (previous?.version ?? 0) + 1,
    }
    entryIntentsRef.current.set(entryId, intent)
    setEntries((current) => current.map((entry) => (entry.id === entryId ? { ...entry, ...updates } : entry)))
    recentLocalWrites.current.set(entryId, Date.now())
    const key = `${entryId}:${Object.keys(updates).sort().join(',')}`
    clearTimeout(entryTimers.current[key])
    entryTimers.current[key] = setTimeout(() => {
      delete entryTimers.current[key]
      if (mountedRef.current && selectedBookIdRef.current === selectedBookId && entryIntentsRef.current.get(entryId) === intent) {
        void persistEntryUpdate(entryId, intent)
      }
    }, 400)
  }, [persistEntryUpdate, selectedBookId, setEntries])

  const handleCreateEntry = useCallback(async () => {
    const entry = await worldBooksApi.createEntry(selectedBookId, {
      comment: t('defaultEntryComment'),
      folder: entryFolder ?? '',
      tags: entryTags,
      key: [],
      content: '',
    })
    recentLocalWrites.current.set(entry.id, Date.now())
    if (presentation === 'workspace') openWorkspaceEntry(entry.id, entry)
    setSelectedEntryId(entry.id)
    setEntryPage(1)
    await loadEntries(selectedBookId, { force: true })
    await refreshVectorSummary()
  }, [entryFolder, entryTags, selectedBookId, loadEntries, refreshVectorSummary, t, presentation, openWorkspaceEntry])

  const handleDeleteEntries = useCallback(async (entryIds: string[]) => {
    entryIds.forEach(invalidateTokenCountsForEntry)
    const generation = requestGenerationRef.current
    try {
      if (entryIds.length === 1) {
        await worldBooksApi.deleteEntry(selectedBookId, entryIds[0], expectedRevisionsFor(entryIds)[entryIds[0]])
      } else {
        await worldBooksApi.bulkEntryAction(selectedBookId, { action: 'delete', entry_ids: entryIds, expected_revisions: expectedRevisionsFor(entryIds) })
      }
      setEntries(current => current.filter(entry => !entryIds.includes(entry.id)))
      setSelectedEntryId((current) => (current && entryIds.includes(current) ? null : current))
      setSelectedIds((current) => current.filter((id) => !entryIds.includes(id)))
      await refetchCurrentPage()
      await refreshVectorSummary()
    } catch (error) {
      const classified = recordMutationIssue(entryIds, error, async () => {
        const revisions = expectedRevisionsFor(entryIds)
        if (entryIds.length === 1) await worldBooksApi.deleteEntry(selectedBookId, entryIds[0], revisions[entryIds[0]])
        else await worldBooksApi.bulkEntryAction(selectedBookId, { action: 'delete', entry_ids: entryIds, expected_revisions: revisions })
        await refetchCurrentPage()
      }, selectedBookId, generation)
      if (!classified) void refetchCurrentPage()
    }
  }, [expectedRevisionsFor, recordMutationIssue, refetchCurrentPage, refreshVectorSummary, selectedBookId, setEntries])

  const handleDuplicateHere = useCallback(async (entryId: string) => {
    const generation = requestGenerationRef.current
    const expected_revision = entriesRef.current.find((entry) => entry.id === entryId)?.revision
    try {
      await worldBooksApi.duplicateEntry(selectedBookId, entryId, expected_revision === undefined ? {} : { expected_revision })
      await refetchCurrentPage()
      await refreshVectorSummary()
    } catch (error) {
      const classified = recordMutationIssue([entryId], error, async () => {
        const revision = entriesRef.current.find((entry) => entry.id === entryId)?.revision
        await worldBooksApi.duplicateEntry(selectedBookId, entryId, revision === undefined ? {} : { expected_revision: revision })
        await refetchCurrentPage()
      }, selectedBookId, generation)
      if (!classified) void refetchCurrentPage()
    }
  }, [recordMutationIssue, refetchCurrentPage, refreshVectorSummary, selectedBookId])


  const handleMoveOrCopy = useCallback(async () => {
    if (!moveCopyState || !moveTargetBookId) return
    const generation = requestGenerationRef.current
    setPendingAction(true)
    try {
      if (moveCopyState.mode === 'move') {
        await worldBooksApi.bulkEntryAction(selectedBookId, {
          action: 'move',
          entry_ids: moveCopyState.entryIds,
          target_book_id: moveTargetBookId,
          expected_revisions: expectedRevisionsFor(moveCopyState.entryIds),
        })
        setSelectedIds((current) => current.filter((id) => !moveCopyState.entryIds.includes(id)))
      } else {
        await worldBooksApi.bulkEntryAction(selectedBookId, {
          action: 'copy',
          entry_ids: moveCopyState.entryIds,
          target_book_id: moveTargetBookId,
          expected_revisions: expectedRevisionsFor(moveCopyState.entryIds),
        })
      }
      setMoveCopyState(null)
      setMoveTargetBookId('')
      await refetchCurrentPage()
      await refreshVectorSummary()
    } catch (error) {
      const ids = moveCopyState.entryIds
      const classified = recordMutationIssue(ids, error, async () => {
        await worldBooksApi.bulkEntryAction(selectedBookId, {
          action: moveCopyState.mode,
          entry_ids: ids,
          target_book_id: moveTargetBookId,
          expected_revisions: expectedRevisionsFor(ids),
        })
        await refetchCurrentPage()
      }, selectedBookId, generation)
      if (!classified) void refetchCurrentPage()
    } finally {
      setPendingAction(false)
    }
  }, [expectedRevisionsFor, moveCopyState, moveTargetBookId, recordMutationIssue, selectedBookId, refetchCurrentPage, refreshVectorSummary])

  const handleBulkRenumber = useCallback(async () => {
    if (!renumberState) return
    const generation = requestGenerationRef.current
    setPendingAction(true)
    try {
      const payload: WorldBookEntryBulkActionInput = {
        action: 'renumber',
        entry_ids: renumberState.entryIds,
        expected_revisions: expectedRevisionsFor(renumberState.entryIds),
        step: Math.max(1, parseInt(renumberStep, 10) || 1),
        direction: renumberDirection,
      }
      if (renumberStart.trim()) {
        payload.start = parseInt(renumberStart, 10)
      }
      await worldBooksApi.bulkEntryAction(selectedBookId, payload)
      setRenumberState(null)
      setRenumberStart('')
      setRenumberStep('1')
      setRenumberDirection('asc')
      await refetchCurrentPage()
    } catch (error) {
      const ids = renumberState.entryIds
      const classified = recordMutationIssue(ids, error, async () => {
        await worldBooksApi.bulkEntryAction(selectedBookId, {
          action: 'renumber', entry_ids: ids, expected_revisions: expectedRevisionsFor(ids),
          step: Math.max(1, parseInt(renumberStep, 10) || 1), direction: renumberDirection,
          ...(renumberStart.trim() ? { start: parseInt(renumberStart, 10) } : {}),
        })
        await refetchCurrentPage()
      }, selectedBookId, generation)
      if (!classified) void refetchCurrentPage()
    } finally {
      setPendingAction(false)
    }
  }, [expectedRevisionsFor, recordMutationIssue, renumberDirection, renumberStart, renumberState, renumberStep, selectedBookId, refetchCurrentPage])

  const handleBulkKeyword = useCallback(async () => {
    if (!keywordState || !keywordValue.trim()) return
    const generation = requestGenerationRef.current
    setPendingAction(true)
    try {
      await worldBooksApi.bulkEntryAction(selectedBookId, {
        action: 'add_keyword',
        entry_ids: keywordState.entryIds,
        expected_revisions: expectedRevisionsFor(keywordState.entryIds),
        keyword: keywordValue.trim(),
        target: keywordTarget,
      })
      setKeywordState(null)
      setKeywordValue('')
      setKeywordTarget('primary')
      await refetchCurrentPage()
      await refreshVectorSummary()
    } catch (error) {
      const ids = keywordState.entryIds
      const classified = recordMutationIssue(ids, error, async () => {
        await worldBooksApi.bulkEntryAction(selectedBookId, {
          action: 'add_keyword', entry_ids: ids, expected_revisions: expectedRevisionsFor(ids),
          keyword: keywordValue.trim(), target: keywordTarget,
        })
        await refetchCurrentPage()
      }, selectedBookId, generation)
      if (!classified) void refetchCurrentPage()
    } finally {
      setPendingAction(false)
    }
  }, [expectedRevisionsFor, keywordState, keywordValue, keywordTarget, recordMutationIssue, selectedBookId, refetchCurrentPage, refreshVectorSummary])

  const handleBulkSetPosition = useCallback(async () => {
    if (!positionState) return
    const generation = requestGenerationRef.current
    setPendingAction(true)
    try {
      const payload: WorldBookEntryBulkActionInput = {
        action: 'set_position',
        entry_ids: positionState.entryIds,
        expected_revisions: expectedRevisionsFor(positionState.entryIds),
        position: bulkPosition,
        ...(bulkPosition === 4 ? { depth: Math.max(0, parseInt(bulkDepth, 10) || 4) } : {}),
      }
      await worldBooksApi.bulkEntryAction(selectedBookId, payload)
      setPositionState(null)
      setBulkPosition(0)
      setBulkDepth('4')
      await refetchCurrentPage()
    } catch (error) {
      const ids = positionState.entryIds
      const classified = recordMutationIssue(ids, error, async () => {
        await worldBooksApi.bulkEntryAction(selectedBookId, {
          action: 'set_position', entry_ids: ids, expected_revisions: expectedRevisionsFor(ids),
          position: bulkPosition, ...(bulkPosition === 4 ? { depth: Math.max(0, parseInt(bulkDepth, 10) || 4) } : {}),
        })
        await refetchCurrentPage()
      }, selectedBookId, generation)
      if (!classified) void refetchCurrentPage()
    } finally {
      setPendingAction(false)
    }
  }, [expectedRevisionsFor, positionState, bulkPosition, bulkDepth, recordMutationIssue, selectedBookId, refetchCurrentPage])

  const handleBulkSetActivation = useCallback(async () => {
    if (!activationState) return
    const generation = requestGenerationRef.current
    setPendingAction(true)
    try {
      await worldBooksApi.bulkEntryAction(selectedBookId, {
        action: 'set_activation',
        entry_ids: activationState.entryIds,
        activation: bulkActivation,
        expected_revisions: expectedRevisionsFor(activationState.entryIds),
      })
      setActivationState(null)
      setBulkActivation('trigger')
      await refetchCurrentPage()
      await refreshVectorSummary()
    } catch (error) {
      const ids = activationState.entryIds
      const classified = recordMutationIssue(ids, error, async () => {
        await worldBooksApi.bulkEntryAction(selectedBookId, {
          action: 'set_activation', entry_ids: ids, activation: bulkActivation,
          expected_revisions: expectedRevisionsFor(ids),
        })
        await refetchCurrentPage()
      }, selectedBookId, generation)
      if (!classified) void refetchCurrentPage()
    } finally {
      setPendingAction(false)
    }
  }, [activationState, bulkActivation, expectedRevisionsFor, recordMutationIssue, selectedBookId, refetchCurrentPage, refreshVectorSummary])

  const handleToggleSelect = useCallback((entryId: string) => {
    setSelectedIds((current) => (
      current.includes(entryId)
        ? current.filter((id) => id !== entryId)
        : [...current, entryId]
    ))
  }, [])

  const handleSelectAllVisible = useCallback(() => {
    setSelectedIds((current) => {
      if (current.length === filteredEntries.length) return []
      return filteredEntries.map((entry) => entry.id)
    })
  }, [filteredEntries])

  const handleSortByChange = useCallback((value: WorldBookEntrySortBy) => {
    const next = {
      sortBy: value,
      sortDir: value === 'custom' ? 'asc' as const : entrySortDir,
      pageSize: entryPageSize,
    }
    setEntrySortBy(next.sortBy)
    setEntrySortDir(next.sortDir)
    setEntryPageSize(next.pageSize)
    setEntryPage(1)
    persistViewPref(selectedBookId, next)
  }, [entrySortDir, entryPageSize, persistViewPref, selectedBookId])

  const handleToggleSortDir = useCallback(() => {
    if (entrySortBy === 'custom') return
    const nextDir = entrySortDir === 'asc' ? 'desc' : 'asc'
    setEntrySortDir(nextDir)
    setEntryPage(1)
    persistViewPref(selectedBookId, { sortBy: entrySortBy, sortDir: nextDir, pageSize: entryPageSize })
  }, [entrySortBy, entrySortDir, entryPageSize, persistViewPref, selectedBookId])

  const handlePageSizeChange = useCallback((value: string) => {
    const nextPageSize = value === 'all' ? 'all' : Number(value) as WorldBookEntryPageSize
    setEntryPageSize(nextPageSize)
    setEntryPage(1)
    persistViewPref(selectedBookId, {
      sortBy: entrySortBy,
      sortDir: entrySortDir,
      pageSize: nextPageSize,
    })
  }, [entrySortBy, entrySortDir, persistViewPref, selectedBookId])

  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    setActiveDragId(String(active.id))
  }, [])

  const handleDragEnd = useCallback(async ({ active, over }: DragEndEvent) => {
    setActiveDragId(null)
    if (!dragEnabled || !over || active.id === over.id) return
    const generation = requestGenerationRef.current
    const oldIndex = entries.findIndex((entry) => entry.id === active.id)
    const newIndex = entries.findIndex((entry) => entry.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const nextEntries = arrayMove(entries, oldIndex, newIndex)
    setEntries(nextEntries)
    const orderedIds = nextEntries.map((entry) => entry.id)
    try {
      await worldBooksApi.reorderEntries(selectedBookId, {
        ordered_ids: orderedIds,
        expected_revisions: expectedRevisionsFor(orderedIds),
      })
      await refetchCurrentPage()
    } catch (error) {
      const classified = recordMutationIssue(orderedIds, error, async () => {
        setEntries(nextEntries)
        await worldBooksApi.reorderEntries(selectedBookId, {
          ordered_ids: orderedIds,
          expected_revisions: expectedRevisionsFor(orderedIds),
        })
        await refetchCurrentPage()
      }, selectedBookId, generation)
      if (!classified) await refetchCurrentPage()
    }
  }, [dragEnabled, entries, expectedRevisionsFor, recordMutationIssue, selectedBookId, refetchCurrentPage, setEntries])

  const detailEntry = (presentation === 'workspace' ? workspaceEntries : entries).find(entry => entry.id === selectedEntryId) ?? null
  const editingDetail = presentation === 'workspace' && !!detailEntry && !mobileBrowsing
  useLayoutEffect(() => { if (active) onDetailViewChange?.(editingDetail) }, [active, editingDetail, onDetailViewChange])
  const tabs = openIds.map(id => workspaceEntries.find(entry => entry.id === id)).filter((entry): entry is WorldBookEntry => !!entry)
  const activateTab = (id: string) => {
    if (id === splitEntryId) setSplitEntryId(selectedEntryId)
    setSelectedEntryId(id); setMobileBrowsing(false); setOpenSwitcher(false)
  }
  const closeTab = (id: string) => {
    closeWorkspaceEntry(id)
    if (selectedEntryId === id) { const index = openIds.indexOf(id); const remaining = openIds.filter(value => value !== id); setSelectedEntryId(remaining[Math.min(index, remaining.length - 1)] ?? null) }
    if (splitEntryId === id || selectedEntryId === id) setSplitEntryId(null)
    const remaining = openIds.filter(value => value !== id)
    const next = selectedEntryId === id ? remaining[Math.min(openIds.indexOf(id), remaining.length - 1)] : selectedEntryId
    scheduleMicrotask(() => {
      if (isMobile) workspaceSwitcherRef.current?.focus()
      else if (next) document.getElementById(`entry-tab-${next}`)?.focus()
      else navigatorToggleRef.current?.focus()
    })
  }
  const openEntry = (entryId: string) => {
    if (onOpenEntry) { onOpenEntry(entryId); return }
    savedListScroll.current = listViewportRef.current?.scrollTop ?? 0
    setSelectedEntryId(current => presentation === 'workspace' ? entryId : current === entryId ? null : entryId)
    setMobileBrowsing(false)
  }
  const backToEntries = () => {
    if (presentation === 'workspace') { setMobileBrowsing(true); setNavigatorCollapsed(false) } else setSelectedEntryId(null)
    window.requestAnimationFrame(() => { if (listViewportRef.current) { listViewportRef.current.scrollTop = savedListScroll.current; listViewportRef.current.querySelector<HTMLButtonElement>(`[data-entry-id="${CSS.escape(selectedEntryId ?? '')}"] button[aria-label]`)?.focus({ preventScroll: true }) } })
  }
  const selectedEntry = contextMenu ? entriesRef.current.find((entry) => entry.id === contextMenu.entryId) ?? null : null
  const selectedTypeEntry = typeMenu ? entries.find((entry) => entry.id === typeMenu.entryId) ?? null : null
  const selectedPositionEntry = positionMenu ? entries.find((entry) => entry.id === positionMenu.entryId) ?? null : null
  const activeDragEntry = activeDragId ? entries.find((entry) => entry.id === activeDragId) ?? null : null
  const contextMenuItems: ContextMenuEntry[] = selectedEntry
    ? [
        {
          key: 'expand',
          label: selectedEntryId === selectedEntry.id ? te('contextCollapseEditor') : te('contextExpandEditor'),
          onClick: () => {
            openEntry(selectedEntry.id)
            setContextMenu(null)
          },
        },
        {
          key: 'duplicate',
          label: te('duplicateHere'),
          icon: <Copy size={14} />,
          onClick: () => {
            setContextMenu(null)
            void handleDuplicateHere(selectedEntry.id)
          },
        },
        {
          key: 'copy',
          label: te('copyToBook'),
          icon: <Copy size={14} />,
          onClick: () => {
            setContextMenu(null)
            setMoveTargetBookId('')
            setMoveCopyState({
              mode: 'copy',
              entryIds: [selectedEntry.id],
              title: te('copyEntryTitle'),
              confirmText: tc('actions.copy'),
            })
          },
          disabled: availableTargetBooks.length === 0,
        },
        {
          key: 'move',
          label: te('moveToBook'),
          icon: <MoveRight size={14} />,
          onClick: () => {
            setContextMenu(null)
            organizationControlsRef.current?.openMove([selectedEntry.id], selectedEntry.folder ?? '')
          },
        },
        { key: 'divider', type: 'divider' },
        {
          key: 'delete',
          label: tc('actions.delete'),
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: () => {
            setContextMenu(null)
            setDeleteState({
              entryIds: [selectedEntry.id],
              title: t('deleteEntryTitle'),
              message: t('deleteEntryMessage'),
            })
          },
        },
      ]
    : []
  const typeMenuItems: ContextMenuEntry[] = selectedTypeEntry
    ? labels.typeOptions.map((option) => ({
        key: option.value,
        label: option.label,
        icon: option.value === 'trigger'
          ? <Zap size={14} />
          : option.value === 'constant'
            ? <Lock size={14} />
            : <Search size={14} />,
        active: getEntryType(selectedTypeEntry) === option.value,
        onClick: () => {
          updateEntry(selectedTypeEntry.id, {
            constant: option.value === 'constant',
            vectorized: option.value === 'vector',
          })
          setTypeMenu(null)
        },
      }))
    : []
  const positionMenuItems: ContextMenuEntry[] = selectedPositionEntry
    ? labels.positionOptions.map((option) => ({
        key: String(option.value),
        label: option.label,
        icon: option.value === 0
          ? <ArrowBigUp size={14} />
          : option.value === 1
            ? <ArrowBigDown size={14} />
            : option.value === 2
              ? <BetweenHorizontalStart size={14} />
              : option.value === 3
                ? <BetweenHorizontalEnd size={14} />
                : option.value === 7
                  ? <MapPin size={14} />
                  : option.value === 8
                    ? <Plug size={14} />
                    : <Hash size={14} />,
        active: selectedPositionEntry.position === option.value,
        onClick: () => {
          updateEntry(selectedPositionEntry.id, { position: option.value })
          setPositionMenu(null)
        },
      }))
    : []
  const paginationControls = entryTotalPages > 1 ? (
    <Pagination
      className={styles.entryPaginationControls}
      currentPage={entryPage}
      totalPages={entryTotalPages}
      onPageChange={(page) => {
        setEntryPage(page)
        if (presentation !== 'workspace') setSelectedEntryId(null)
        setSelectedIds([])
      }}
      totalItems={entryTotal}
    />
  ) : null
  const pagination = paginationControls && !paginationContainer ? (
    <div className={styles.entryPagination}>
      {paginationControls}
    </div>
  ) : null
  const dockedPagination = paginationControls && paginationContainer
    ? createPortal(
        <div className={styles.entryPaginationDocked}>
          {paginationControls}
        </div>,
        paginationContainer,
      )
    : null

  return (
    <div
      ref={sectionRef}
      className={clsx(
        styles.section,
        usesSharedScroll ? styles.sectionSharedScroll : styles.sectionStandaloneScroll,
        isMobile && styles.sectionMobile,
        presentation === 'workspace' && styles.workspace,
        presentation === 'workspace' && detailEntry && !mobileBrowsing && styles.detailOpen,
      )}
      data-world-book-entries-book-id={selectedBookId ?? undefined}
      onKeyDownCapture={(event) => {
        if (event.defaultPrevented || event.altKey || event.shiftKey) return
        if ((!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== 'f') return
        event.preventDefault()
        event.stopPropagation()
        setNavigatorCollapsed(false); setMobileBrowsing(true)
        window.requestAnimationFrame(() => entrySearchInputRef.current?.focus())
        entrySearchInputRef.current?.select()
      }}
    >
      {presentation === 'workspace' && <header className={styles.workspaceBar}>
        <button type="button" ref={isMobile ? detailBackRef : navigatorToggleRef} className={styles.toolbarBtn} aria-expanded={!navigatorCollapsed && (!isMobile || mobileBrowsing || !detailEntry)} onClick={() => { if (isMobile) { if (detailEntry && !mobileBrowsing) backToEntries(); else setMobileBrowsing(false) } else setNavigatorCollapsed(value => !value) }}>{isMobile ? detailEntry && !mobileBrowsing ? '‹ Entries' : detailEntry ? 'Editor' : 'Entries' : navigatorCollapsed ? 'Show entries' : 'Hide entries'}</button>
        {isMobile && detailEntry && !mobileBrowsing && <strong className={styles.mobileEntryTitle}>{detailEntry.comment || '(unnamed)'}</strong>}
        {isMobile ? <button type="button" ref={workspaceSwitcherRef} className={styles.toolbarBtn} aria-expanded={openSwitcher} onClick={() => setOpenSwitcher(value => !value)}>{tabs.length} open</button> : <div role="tablist" aria-label="Open entries" className={styles.tabStrip}>{tabs.map(entry => <div key={entry.id} className={styles.workspaceTab}>
          <button type="button" role="tab" aria-selected={entry.id === selectedEntryId} aria-controls={`entry-panel-${entry.id}`} id={`entry-tab-${entry.id}`} tabIndex={entry.id === selectedEntryId || (!detailEntry && entry.id === openIds[0]) ? 0 : -1} onClick={() => activateTab(entry.id)} onKeyDown={event => {
            const index = openIds.indexOf(entry.id)
            const next = event.key === 'ArrowRight' ? openIds[(index + 1) % openIds.length] : event.key === 'ArrowLeft' ? openIds[(index + openIds.length - 1) % openIds.length] : event.key === 'Home' ? openIds[0] : event.key === 'End' ? openIds.at(-1) : null
            if (next) { event.preventDefault(); activateTab(next); document.getElementById(`entry-tab-${next}`)?.focus() }
          }}>{entry.comment || '(unnamed)'}</button>
          <button type="button" aria-label={`Close tab ${entry.comment || '(unnamed)'}`} onClick={() => closeTab(entry.id)}>×</button>
        </div>)}</div>}
        {isMobile && detailEntry && !mobileBrowsing && <button type="button" className={styles.moreBtn} aria-label="Entry detail actions" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setContextMenu({ entryId: detailEntry.id, position: { x: rect.right, y: rect.bottom } }) }}><MoreVertical size={14} /></button>}
        {!isMobile && tabs.length > 1 && <><button type="button" className={styles.toolbarBtn} aria-pressed={!!splitEntryId} onClick={() => setSplitEntryId(current => current ? null : openIds.find(id => id !== selectedEntryId) ?? null)}>{splitEntryId ? 'Close split' : 'Split'}</button>{splitEntryId && <><select aria-label="Split entry" value={splitEntryId} onChange={event => setSplitEntryId(event.target.value)}>{tabs.filter(entry => entry.id !== selectedEntryId).map(entry => <option key={entry.id} value={entry.id}>{entry.comment || '(unnamed)'}</option>)}</select><button type="button" className={styles.toolbarBtn} onClick={() => activateTab(splitEntryId)}>Swap panes</button></>}</>}
      </header>}
      {presentation === 'workspace' && isMobile && openSwitcher && <nav className={styles.openSwitcher} aria-label="Open entry switcher">{tabs.map(entry => <div key={entry.id}><button type="button" onClick={() => activateTab(entry.id)}>{entry.comment || '(unnamed)'}</button><button type="button" aria-label={`Close tab ${entry.comment || '(unnamed)'}`} onClick={() => closeTab(entry.id)}>×</button></div>)}</nav>}
      <div className={presentation === 'workspace' ? styles.workspaceBody : undefined}>
      <div ref={listViewportRef} className={presentation === 'workspace' ? styles.workspaceList : undefined} style={presentation === 'workspace' && !isMobile ? { flexBasis: navigatorWidth } : undefined} hidden={presentation === 'workspace' && (isMobile ? !!detailEntry && !mobileBrowsing : navigatorCollapsed)}>
      {selectedBookId && <EntryOrganizationControls ref={organizationControlsRef} key={selectedBookId} bookId={selectedBookId} books={books} summary={organization} folder={entryFolder} root={showFolderRoot} tags={entryTags} entries={allKnownEntries} selectedIds={selectedIds} busy={pendingAction || loadingEntries} hideFilters={isMobile && !mobileListOptionsOpen} hideSelectionActions
        onRoot={() => { setFolderRoot(true); setSelectedIds([]) }}
        onTags={tags => { setEntryTags(tags); setEntryPage(1); setSelectedIds([]) }}
        onFolderChanged={value => { setEntryFolder(value); setFolderRoot(value === undefined); setEntryTags([]); setEntryPage(1); setSelectedIds([]) }}
        onReload={() => loadEntries(selectedBookId, { force: true })} />}
      {entriesError && <div role="alert">{entriesError}<button type="button" onClick={() => void loadEntries(selectedBookId, { force: true }).catch(() => {})}>Retry Refresh</button></div>}
      {showFolderRoot ? <div className={clsx(styles.entryScroll, usesSharedScroll && styles.entryScrollShared)}><EntryFolderList summary={organization} onOpen={value => { setEntryFolder(value); setFolderRoot(false); setEntryTags([]); setEntryPage(1); setSelectedIds([]) }} /></div> : <>
      <label className={styles.displayOption} hidden={isMobile && !mobileListOptionsOpen}><input type="checkbox" checked={showTokens} onChange={event => setShowTokens(event.target.checked)} /> Show token counts</label>
      <div className={clsx(styles.entryListHeader, isMobile && styles.entryListHeaderMobile)}>
        <span className={styles.entryListTitle}>{te('entriesTitle', { count: entryTotal })}</span>
        <div className={clsx(styles.toolbarActions, isMobile && styles.toolbarActionsMobile)}>
          <button
            type="button"
            className={clsx(styles.toolbarBtn, selectMode && styles.toolbarBtnActive)}
            onClick={() => {
              setSelectMode((current) => {
                if (current) setSelectedIds([])
                return !current
              })
            }}
            title={selectMode ? te('exitBulkSelect') : te('bulkSelect')}
          >
            {selectMode ? <CheckSquare size={13} /> : <Square size={13} />}
            <span>{te('select')}</span>
          </button>
          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={() => setShowTokenReport(true)}
            title={t('tokenReportOpen')}
          >
            <Hash size={13} />
            <span>{t('tokenReportOpen')}</span>
          </button>
          <button type="button" className={styles.newEntryBtn} onClick={() => void handleCreateEntry()}>
            <Plus size={12} />
            <span>{te('newEntry')}</span>
          </button>
        </div>
      </div>

      <div className={clsx(styles.entrySearchRow, isMobile && styles.entrySearchRowMobile)}>
        <div className={styles.entrySearch}>
          <Search size={14} className={styles.entrySearchIcon} />
          <input
            ref={entrySearchInputRef}
            type="search"
            className={styles.entrySearchInput}
            placeholder={te('searchAll')}
            aria-label={te('searchAll')}
            value={entrySearchFilter}
            onChange={(e) => {
              setEntrySearchFilter(e.target.value)
              setEntryPage(1)
            }}
            onKeyDown={(e) => clearSearchOnEscape(e, entrySearchFilter, () => {
              setEntrySearchFilter('')
              setEntryPage(1)
            })}
          />
          {(searchActive || entryTypeFilter !== 'all') && (
            <span
              className={styles.entrySearchCount}
              aria-live="polite"
              aria-label={`${entryTotal} of ${entries.length} entries shown`}
            >
              {entryTotal}/{entries.length}
            </span>
          )}
          {entrySearchFilter && (
            <button
              type="button"
              className={styles.entrySearchClear}
              onClick={() => {
                setEntrySearchFilter('')
                setEntryPage(1)
              }}
              aria-label="Clear entry search"
              title="Clear entry search"
            >
              <X size={13} />
            </button>
          )}
        </div>
        {isMobile && (
          <button
            type="button"
            className={clsx(styles.listOptionsToggle, mobileListOptionsOpen && styles.listOptionsToggleActive)}
            onClick={() => setMobileListOptionsOpen((current) => !current)}
            aria-expanded={mobileListOptionsOpen}
            title={te('sortBy')}
            aria-label="Entry filters and options"
          >
            <ArrowUpDown size={13} />
            <span className={styles.listOptionsSummary}>{mobileListOptionsSummary}</span>
            <ChevronDown
              size={12}
              className={clsx(styles.listOptionsChevron, mobileListOptionsOpen && styles.listOptionsChevronOpen)}
            />
          </button>
        )}
      </div>

      <div className={styles.entryTypeFilters} role="group" aria-label="Filter entries by trigger type">
        {([
          ['all', 'All', sourceEntryTotal],
          ['trigger', labels.typeOptions.find((option) => option.value === 'trigger')?.label ?? 'Trigger', typeCounts.trigger],
          ['constant', labels.typeOptions.find((option) => option.value === 'constant')?.label ?? 'Constant', typeCounts.constant],
          ['vector', labels.typeOptions.find((option) => option.value === 'vector')?.label ?? 'Vector', typeCounts.vector],
        ] as const).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            className={clsx(
              styles.entryTypeFilter,
              value !== 'all' && styles[`entryTypeFilter_${value}`],
              entryTypeFilter === value && styles.entryTypeFilterActive,
            )}
            aria-pressed={entryTypeFilter === value}
            onClick={() => {
              setEntryTypeFilter(value)
              setEntryPage(1)
            }}
          >
            <span>{label}</span><b>{value === 'all' ? count : '—'}</b>
          </button>
        ))}
      </div>

      {(!isMobile || mobileListOptionsOpen) && (
        <div className={clsx(styles.entrySortRow, isMobile && styles.entrySortRowMobile)}>
          <select
            className={styles.entrySortSelect}
            value={entrySortBy}
            onChange={(e) => handleSortByChange(e.target.value as WorldBookEntrySortBy)}
            title={te('sortBy')}
          >
            {labels.sortOptions.map((option) => (
              <option key={option.value} value={option.value}>{te('sortPrefix', { label: option.label })}</option>
            ))}
          </select>
          <select
            className={styles.entryPageSizeSelect}
            value={String(entryPageSize)}
            onChange={(e) => handlePageSizeChange(e.target.value)}
            title={te('perPage')}
          >
            {labels.pageSizeOptions.filter(option => option.value !== 'all').map((option) => (
              <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
            ))}
          </select>
          {entrySortBy !== 'custom' && (
            <button
              type="button"
              className={styles.entrySortDirBtn}
              onClick={handleToggleSortDir}
              title={entrySortDir === 'asc' ? te('sortAsc') : te('sortDesc')}
            >
              {entrySortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
              <ArrowUpDown size={10} />
            </button>
          )}
        </div>
      )}


      {selectMode && (
        <div className={styles.bulkBar}>
          <div className={styles.bulkLeft}>
            <button type="button" className={styles.bulkToggle} aria-label={allSelected ? 'Deselect visible entries' : 'Select visible entries'} onClick={handleSelectAllVisible}>
              {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
            </button>
            <span className={styles.bulkCount}>{te('bulkSelected', { selected: selectedCount, total: filteredEntries.length })}</span>
          </div>
          <div className={styles.bulkActions}>
            <button
              type="button"
              ref={bulkActionsTriggerRef}
              aria-label="Selected entry actions"
              className={styles.bulkActionBtn}
              disabled={selectedCount === 0}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setBulkActionsMenu({ x: rect.left, y: rect.bottom })
              }}
            >
              <MoreVertical size={13} />
              <span>{te('moreActions')}</span>
            </button>
            <button
              type="button"
              className={clsx(styles.bulkActionBtn, styles.bulkDeleteBtn)}
              disabled={selectedCount === 0}
              onClick={() => {
                setDeleteState({
                  entryIds: selectedIds,
                  title: te('deleteEntriesTitle'),
                  message: te('deleteCountMessage', { count: selectedCount }),
                })
              }}
            >
              <Trash2 size={13} />
              <span>{tc('actions.delete')}</span>
            </button>
            <button
              type="button"
              className={styles.bulkActionBtn}
              onClick={() => {
                setSelectMode(false)
                setSelectedIds([])
              }}
            >
              <X size={13} />
              <span>{tc('actions.cancel')}</span>
            </button>
          </div>
        </div>
      )}

      {loadingEntries ? (
        <div className={styles.emptyState}>{te('loading')}</div>
      ) : (
        <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <SortableContext items={renderedEntries.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
              <div
                ref={usesSharedScroll ? undefined : localScrollRef}
                className={clsx(styles.entryScroll, usesSharedScroll && styles.entryScrollShared)}
              >
                <div ref={entryListRef} className={styles.entryList}>
                  {filteredEntries.length === 0 && (
                    <div className={styles.emptyState}>
                      <span>
                        {searchActive
                          ? entryTypeFilter === 'all'
                            ? te('noMatch')
                            : 'No entries match the search and selected type.'
                          : entryTypeFilter === 'all'
                            ? te('empty')
                            : 'No entries use the selected type.'}
                      </span>
                      {(searchActive || entryTypeFilter !== 'all') && (
                        <div className={styles.emptyStateActions}>
                          {searchActive && (
                            <button type="button" onClick={() => { setEntrySearchFilter(''); setEntryPage(1) }}>
                              Clear search
                            </button>
                          )}
                          {entryTypeFilter !== 'all' && (
                            <button type="button" onClick={() => { setEntryTypeFilter('all'); setEntryPage(1) }}>
                              Show all types
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {renderedEntries.map((entry, index) => {
                    const retainedByFilter = retainedSelectedEntry?.id === entry.id
                    return (
                      <div
                        key={entry.id}
                        data-index={index}
                        data-entry-id={entry.id}
                        className={styles.entryListItem}
                      >
                        <EntryRow
                          bookId={selectedBookId}
                          editorDensity={editorDensity}
                          entry={entry}
                          expanded={selectedEntryId === entry.id}
                          dragEnabled={dragEnabled && !retainedByFilter}
                          selectMode={selectMode && !retainedByFilter}
                          selected={!retainedByFilter && selectedIds.includes(entry.id)}
                          searchResult={entrySearchResultsById.get(entry.id)}
                          retainedByFilter={retainedByFilter}
                          onToggleExpand={() => openEntry(entry.id)}
                          inlineEditor={!presentation}
                          workspaceMode={presentation === 'workspace'}
                          workspaceOpen={openIds.includes(entry.id)}
                          mobile={isMobile || presentation === 'workspace'}
                          showTokens={showTokens}
                          onToggleSelect={() => handleToggleSelect(entry.id)}
                          onUpdate={updateEntry}
                          onDebouncedUpdate={debouncedUpdateEntry}
                          onOpenMenu={(entryId, position) => setContextMenu({ entryId, position })}
                          onOpenTypeMenu={(entryId, position) => setTypeMenu({ entryId, position })}
                          onOpenPositionMenu={(entryId, position) => setPositionMenu({ entryId, position })}
                          conflict={entryConflicts[entry.id]}
                          onRetryConflict={() => retryConflict(entry.id)}
                          onUseServerConflict={() => acceptServerConflict(entry.id)}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            </SortableContext>
            <DragOverlay dropAnimation={null}>
              {activeDragEntry && (
                <EntryRowContent
                  bookId={selectedBookId}
                  editorDensity={editorDensity}
                  entry={activeDragEntry}
                  expanded={selectedEntryId === activeDragEntry.id}
                  dragEnabled={dragEnabled}
                  selectMode={selectMode}
                  selected={selectedIds.includes(activeDragEntry.id)}
                  onToggleExpand={() => setSelectedEntryId((current) => (current === activeDragEntry.id ? null : activeDragEntry.id))}
                  onToggleSelect={() => handleToggleSelect(activeDragEntry.id)}
                  onUpdate={updateEntry}
                  onDebouncedUpdate={debouncedUpdateEntry}
                  onOpenMenu={(entryId, position) => setContextMenu({ entryId, position })}
                  onOpenTypeMenu={(entryId, position) => setTypeMenu({ entryId, position })}
                  onOpenPositionMenu={(entryId, position) => setPositionMenu({ entryId, position })}
                  conflict={entryConflicts[activeDragEntry.id]}
                  onRetryConflict={() => retryConflict(activeDragEntry.id)}
                  onUseServerConflict={() => acceptServerConflict(activeDragEntry.id)}
                  isDragging
                />
              )}
            </DragOverlay>
          </DndContext>

          {pagination}
        </>
      )}

      <ContextMenu
        position={contextMenu?.position ?? null}
        items={contextMenuItems}
        onClose={() => setContextMenu(null)}
      />

      <ContextMenu
        position={typeMenu?.position ?? null}
        items={typeMenuItems}
        onClose={() => setTypeMenu(null)}
      />

      <ContextMenu
        position={positionMenu?.position ?? null}
        items={positionMenuItems}
        onClose={() => setPositionMenu(null)}
      />

      <ContextMenu
        position={bulkActionsMenu}
        items={[
          { key: 'organization-move', label: 'Move selected…', icon: <MapPin size={14} />, onClick: () => { setBulkActionsMenu(null); organizationControlsRef.current?.openMove(selectedIds, entryFolder ?? '', bulkActionsTriggerRef.current ?? undefined) } },
          { key: 'organization-add-tags', label: 'Add tags…', icon: <Tag size={14} />, onClick: () => { setBulkActionsMenu(null); organizationControlsRef.current?.openTags?.('add_tags', selectedIds, bulkActionsTriggerRef.current ?? undefined) } },
          { key: 'organization-remove-tags', label: 'Remove tags…', icon: <Tag size={14} />, onClick: () => { setBulkActionsMenu(null); organizationControlsRef.current?.openTags?.('remove_tags', selectedIds, bulkActionsTriggerRef.current ?? undefined) } },
          {
            key: 'renumber',
            label: te('renumber'),
            icon: <Hash size={14} />,
            onClick: () => {
              setBulkActionsMenu(null)
              setRenumberStart('')
              setRenumberStep('1')
              setRenumberDirection('asc')
              setRenumberState({ entryIds: selectedIds })
            },
          },
          {
            key: 'keyword',
            label: te('addKeyword'),
            icon: <Tag size={14} />,
            onClick: () => {
              setBulkActionsMenu(null)
              setKeywordValue('')
              setKeywordTarget('primary')
              setKeywordState({ entryIds: selectedIds })
            },
          },
          {
            key: 'position',
            label: te('setPosition'),
            icon: <MapPin size={14} />,
            onClick: () => {
              setBulkActionsMenu(null)
              setBulkPosition(0)
              setBulkDepth('4')
              setPositionState({ entryIds: selectedIds })
            },
          },
          {
            key: 'activation',
            label: te('setActivation'),
            icon: <Zap size={14} />,
            onClick: () => {
              setBulkActionsMenu(null)
              setBulkActivation('trigger')
              setActivationState({ entryIds: selectedIds })
            },
          },
        ]}
        onClose={() => setBulkActionsMenu(null)}
      />

      {selectedBook && (
        <WorldBookTokenReportModal
          isOpen={showTokenReport}
          onClose={() => setShowTokenReport(false)}
          bookId={selectedBook.id}
          bookName={selectedBook.name}
        />
      )}

      {deleteState && (
        <ConfirmationModal
          isOpen={true}
          title={deleteState.title}
          message={deleteState.message}
          variant="danger"
          confirmText={tc('actions.delete')}
          onConfirm={async () => {
            setPendingAction(true)
            try {
              await handleDeleteEntries(deleteState.entryIds)
              setDeleteState(null)
            } finally {
              setPendingAction(false)
            }
          }}
          onCancel={() => !pendingAction && setDeleteState(null)}
        />
      )}

      {moveCopyState && (
        <ModalPresentation
          isOpen={true}
          onClose={() => !pendingAction && setMoveCopyState(null)}
          maxWidth="clamp(320px, 90vw, min(520px, var(--lumiverse-content-max-width, 520px)))"
          closeOnBackdrop={!pendingAction}
          closeOnEscape={!pendingAction}
          title={moveCopyState.title}
          subtitle={selectedBook ? te('moveCopyFrom', { name: selectedBook.name }) : undefined}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setMoveCopyState(null)} disabled={pendingAction}>{tc('actions.cancel')}</Button>
              <Button variant="primary" onClick={() => void handleMoveOrCopy()} disabled={pendingAction || !moveTargetBookId}>
                {moveCopyState.confirmText}
              </Button>
            </>
          )}
        >
          <FormField label={te('targetWorldBook')} className={styles.dialogFormField}>
            <SearchableSelect
              value={moveTargetBookId}
              onChange={(value) => setMoveTargetBookId(value || '')}
              options={availableTargetBooks}
              placeholder={te('chooseWorldBook')}
              searchPlaceholder={t('searchWorldBooks')}
              emptyMessage={te('noOtherBooks')}
              portal
            />
          </FormField>
        </ModalPresentation>
      )}
      {dockedPagination}

      {renumberState && (
        <ModalPresentation
          isOpen={true}
          onClose={() => !pendingAction && setRenumberState(null)}
          maxWidth="clamp(320px, 90vw, min(520px, var(--lumiverse-content-max-width, 520px)))"
          closeOnBackdrop={!pendingAction}
          closeOnEscape={!pendingAction}
          title={te('renumberTitle')}
          subtitle={te('renumberHint')}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setRenumberState(null)} disabled={pendingAction}>{tc('actions.cancel')}</Button>
              <Button variant="primary" onClick={() => void handleBulkRenumber()} disabled={pendingAction}>{tc('actions.apply')}</Button>
            </>
          )}
        >
          <div className={styles.dialogGrid}>
            <FormField label={te('startNumber')} className={styles.dialogFormField}>
              <TextInput
                type="number"
                value={renumberStart}
                onChange={setRenumberStart}
                placeholder={te('startNumberPlaceholder')}
              />
            </FormField>
            <FormField label={te('step')} className={styles.dialogFormField}>
              <TextInput type="number" min={1} value={renumberStep} onChange={setRenumberStep} />
            </FormField>
            <FormField label={te('direction')} className={styles.dialogFormField}>
              <Select
                value={renumberDirection}
                onChange={(value) => setRenumberDirection(value as 'asc' | 'desc')}
                options={[
                  { value: 'asc', label: te('sortAsc') },
                  { value: 'desc', label: te('sortDesc') },
                ]}
              />
            </FormField>
          </div>
        </ModalPresentation>
      )}

      {keywordState && (
        <ModalPresentation
          isOpen={true}
          onClose={() => !pendingAction && setKeywordState(null)}
          maxWidth="clamp(320px, 90vw, min(520px, var(--lumiverse-content-max-width, 520px)))"
          closeOnBackdrop={!pendingAction}
          closeOnEscape={!pendingAction}
          title={te('keywordTitle')}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setKeywordState(null)} disabled={pendingAction}>{tc('actions.cancel')}</Button>
              <Button variant="primary" onClick={() => void handleBulkKeyword()} disabled={pendingAction || !keywordValue.trim()}>{tc('actions.add')}</Button>
            </>
          )}
        >
          <div className={styles.dialogGrid}>
            <FormField label={te('keyword')} className={styles.dialogFormField}>
              <TextInput
                value={keywordValue}
                onChange={setKeywordValue}
                placeholder={te('keywordPlaceholder')}
              />
            </FormField>
            <FormField label={te('keywordList')} className={styles.dialogFormField}>
              <Select
                value={keywordTarget}
                onChange={(value) => setKeywordTarget(value as 'primary' | 'secondary')}
                options={[
                  { value: 'primary', label: te('keywordPrimary') },
                  { value: 'secondary', label: te('keywordSecondary') },
                ]}
              />
            </FormField>
          </div>
        </ModalPresentation>
      )}

      {positionState && (
        <ModalPresentation
          isOpen={true}
          onClose={() => !pendingAction && setPositionState(null)}
          maxWidth="clamp(320px, 90vw, min(520px, var(--lumiverse-content-max-width, 520px)))"
          closeOnBackdrop={!pendingAction}
          closeOnEscape={!pendingAction}
          title={te('setPositionTitle')}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setPositionState(null)} disabled={pendingAction}>{tc('actions.cancel')}</Button>
              <Button variant="primary" onClick={() => void handleBulkSetPosition()} disabled={pendingAction}>{tc('actions.apply')}</Button>
            </>
          )}
        >
          <div className={styles.dialogGrid}>
            <FormField label={te('position')} className={styles.dialogFormField}>
              <Select
                value={String(bulkPosition)}
                onChange={(value) => setBulkPosition(Number(value))}
                options={labels.positionOptions.map((opt) => ({
                  value: String(opt.value),
                  label: opt.label,
                }))}
              />
            </FormField>
            {bulkPosition === 4 && (
              <FormField label={te('depth')} className={styles.dialogFormField}>
                <TextInput type="number" min={0} value={bulkDepth} onChange={setBulkDepth} />
              </FormField>
            )}
          </div>
        </ModalPresentation>
      )}

      {activationState && (
        <ModalPresentation
          isOpen={true}
          onClose={() => !pendingAction && setActivationState(null)}
          maxWidth="clamp(320px, 90vw, min(520px, var(--lumiverse-content-max-width, 520px)))"
          closeOnBackdrop={!pendingAction}
          closeOnEscape={!pendingAction}
          title={te('setActivationTitle')}
          subtitle={te('setActivationHint', { count: activationState.entryIds.length })}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setActivationState(null)} disabled={pendingAction}>{tc('actions.cancel')}</Button>
              <Button variant="primary" onClick={() => void handleBulkSetActivation()} disabled={pendingAction}>{tc('actions.apply')}</Button>
            </>
          )}
        >
          <FormField label={te('activationMethod')} className={styles.dialogFormField}>
            <Select
              value={bulkActivation}
              onChange={(value) => setBulkActivation(value as 'trigger' | 'constant' | 'vector')}
              options={labels.typeOptions}
            />
          </FormField>
        </ModalPresentation>
      )}
      </>}
      </div>
      {presentation === 'workspace' && !isMobile && !navigatorCollapsed && <WorldBookColumnHandle label="Resize entries column" width={navigatorWidth} defaultWidth={300} min={200} max={420} collapseBelow={140} onResize={setNavigatorWidth} onCollapse={() => { setNavigatorCollapsed(true); scheduleMicrotask(() => navigatorToggleRef.current?.focus()) }} />}
      {presentation === 'workspace' && <div className={styles.editorWorkspace} hidden={isMobile && (mobileBrowsing || !detailEntry)}>
        {!detailEntry && <p className={styles.workspaceEmpty}>Open an entry to start editing.</p>}
        {tabs.map(entry => {
          const visible = entry.id === selectedEntryId || (!isMobile && entry.id === splitEntryId)
          return <section key={entry.id} ref={entry.id === selectedEntryId ? detailViewportRef : undefined} className={styles.workspaceDetail} style={{ order: entry.id === selectedEntryId ? 0 : 1 }} hidden={!visible} role="tabpanel" id={`entry-panel-${entry.id}`} aria-labelledby={!isMobile ? `entry-tab-${entry.id}` : undefined} aria-label="Entry detail">
            <header className={styles.detailHeader} hidden={isMobile}>
              {!isMobile && entry.id === selectedEntryId && <button ref={detailBackRef} type="button" className={styles.toolbarBtn} onClick={backToEntries}>‹ Entries</button>}
              <strong>{entry.comment || '(unnamed)'}</strong>
              <button type="button" className={styles.moreBtn} aria-label="Entry detail actions" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setContextMenu({ entryId: entry.id, position: { x: rect.right, y: rect.bottom } }) }}><MoreVertical size={14} /></button>
            </header>
            <WorldBookEntryEditor entry={entry} density={editorDensity} onUpdate={debouncedUpdateEntry} onImmediateUpdate={updateEntry} conflict={entryConflicts[entry.id]} onRetryConflict={() => retryConflict(entry.id)} onUseServerConflict={() => acceptServerConflict(entry.id)} />
          </section>
        })}
      </div>}
      </div>
    </div>
  )
}
