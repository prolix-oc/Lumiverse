import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  DndContext,
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
import { useScaledSortableStyle } from '@/lib/dndUiScale'
import { useScrollGate } from '@/hooks/useScrollGate'
import useIsMobile from '@/hooks/useIsMobile'
import clsx from 'clsx'
import { worldBooksApi } from '@/api/world-books'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import type {
  WorldBookChangedPayload,
  WorldBookEntryChangedPayload,
  WorldBookEntryDeletedPayload,
} from '@/types/ws-events'
import WorldBookEntryEditor from '@/components/shared/WorldBookEntryEditor'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import SearchableSelect from '@/components/shared/SearchableSelect'
import { FormField, Select, TextInput, Button } from '@/components/shared/FormComponents'
import { ModalShell } from '@/components/shared/ModalShell'
import Pagination from '@/components/shared/Pagination'
import { useStore } from '@/store'
import type {
  WorldBook,
  WorldBookEntry,
  WorldBookEntryBulkActionInput,
} from '@/types/api'
import type {
  WorldBookEntrySortBy,
  WorldBookEntrySortDir,
  WorldBookEntryPageSize,
} from '@/types/store'
import styles from './WorldBookEntriesSection.module.css'

const DEFAULT_PAGE_SIZE = 50 as const
const CUSTOM_PAGE_SIZE = 200 as const
const ENTRY_FIELD_VISIBLE_TOP_GUTTER = 12
const ENTRY_FIELD_KEYBOARD_GUTTER = 72
const ENTRY_FIELD_REVEAL_THRESHOLD = 10
const ENTRY_FIELD_FOCUS_SETTLE_DELAYS = [40, 180, 360, 520] as const

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

function getEntryFieldBottomGutter(container: HTMLElement): number {
  const style = getComputedStyle(container)
  const footerHeight = parseCssPx(style.getPropertyValue('--worldbook-footer-height'))
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

function mapSortForApi(sortBy: WorldBookEntrySortBy): 'order' | 'priority' | 'created' | 'updated' | 'name' {
  return sortBy === 'custom' ? 'order' : sortBy
}

function getEntryType(entry: WorldBookEntry): 'trigger' | 'constant' | 'vector' {
  if (entry.constant) return 'constant'
  if (entry.vectorized) return 'vector'
  return 'trigger'
}

function useFormatEntryCount() {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entries' })
  return useCallback((count: number) => t('entryCount', { count }), [t])
}

interface EntryRowProps {
  entry: WorldBookEntry
  expanded: boolean
  dragEnabled: boolean
  selectMode: boolean
  selected: boolean
  onToggleExpand: () => void
  onToggleSelect: () => void
  onUpdate: (entryId: string, updates: Record<string, any>) => void
  onDebouncedUpdate: (entryId: string, updates: Record<string, any>) => void
  onOpenMenu: (entryId: string, position: ContextMenuPos) => void
  onOpenTypeMenu: (entryId: string, position: ContextMenuPos) => void
  onOpenPositionMenu: (entryId: string, position: ContextMenuPos) => void
}

interface EntryRowContentProps extends EntryRowProps {
  dragHandleAttributes?: DraggableAttributes
  dragHandleListeners?: Record<string, unknown>
  isDragging?: boolean
}

function EntryRowContent({
  entry,
  expanded,
  dragEnabled,
  selectMode,
  selected,
  onToggleExpand,
  onToggleSelect,
  onUpdate,
  onDebouncedUpdate,
  onOpenMenu,
  onOpenTypeMenu,
  onOpenPositionMenu,
  dragHandleAttributes,
  dragHandleListeners,
  isDragging,
}: EntryRowContentProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entries' })
  const { t: tEntryFields } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entryEditor.fields' })
  const labels = useWorldBookEntryLabels()
  const { markerLabel } = useLoomOptionLabels()

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
            <button
              type="button"
              className={clsx(styles.dragHandle, !dragEnabled && styles.dragHandleDisabled)}
              title={dragEnabled ? t('dragReorder') : t('dragUnavailable')}
              aria-label={t('dragHandle')}
              tabIndex={-1}
              {...dragHandleAttributes}
              {...dragHandleListeners}
            >
              <GripVertical size={13} />
            </button>
          </div>

          <div className={styles.entryIdentity}>
              <span className={styles.entryComment}>{entry.comment || '(unnamed)'}</span>
              <div className={styles.entryMeta}>
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
                <span
                  className={clsx(styles.entryMetaItem, styles.orderBadge)}
                  title={`${tEntryFields('order')}: ${entry.order_value.toLocaleString()}`}
                  {...controlWrapProps}
                >
                  <Hash size={10} aria-hidden="true" />
                  <span>{entry.order_value.toLocaleString()}</span>
                </span>
              </div>
            </div>

            <div className={styles.entryActions} {...controlWrapProps}>
            <button
              type="button"
              className={styles.expandBtn}
              onClick={onToggleExpand}
              title={expanded ? t('collapseEditor') : t('expandEditor')}
              aria-label={expanded ? t('collapseEditor') : t('expandEditor')}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span>{expanded ? t('collapse') : t('expand')}</span>
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

      {expanded && (
        <WorldBookEntryEditor
          entry={entry}
          onUpdate={onDebouncedUpdate}
          onImmediateUpdate={onUpdate}
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

interface WorldBookEntriesSectionProps {
  books: WorldBook[]
  selectedBookId: string
  onRefreshVectorSummary?: (bookId: string) => Promise<void> | void
  scrollContainerRef?: { current: HTMLDivElement | null }
  paginationContainer?: HTMLDivElement | null
}

export default function WorldBookEntriesSection({
  books,
  selectedBookId,
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
  const setSetting = useStore((s) => s.setSetting)
  const isMobile = useIsMobile()

  const [entries, setEntries] = useState<WorldBookEntry[]>([])
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [entryTotal, setEntryTotal] = useState(0)
  const [entryPage, setEntryPage] = useState(1)
  const [loadingEntries, setLoadingEntries] = useState(false)
  const [entrySearchFilter, setEntrySearchFilter] = useState('')
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
  const [moveTargetBookId, setMoveTargetBookId] = useState('')
  const [renumberStart, setRenumberStart] = useState('')
  const [renumberStep, setRenumberStep] = useState('1')
  const [renumberDirection, setRenumberDirection] = useState<'asc' | 'desc'>('asc')
  const [keywordValue, setKeywordValue] = useState('')
  const [keywordTarget, setKeywordTarget] = useState<'primary' | 'secondary'>('primary')
  const [positionState, setPositionState] = useState<{ entryIds: string[] } | null>(null)
  const [bulkPosition, setBulkPosition] = useState(0)
  const [bulkDepth, setBulkDepth] = useState('4')
  const [pendingAction, setPendingAction] = useState(false)
  const entryTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const sectionRef = useRef<HTMLDivElement>(null)
  const localScrollRef = useRef<HTMLDivElement>(null)
  const focusedEntryFieldRef = useRef<HTMLElement | null>(null)
  const focusRevealFrameRef = useRef(0)
  const focusRevealTimersRef = useRef<number[]>([])
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const activeScrollRef = scrollContainerRef ?? localScrollRef
  const usesSharedScroll = scrollContainerRef != null
  useScrollGate(activeScrollRef)

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
      scheduleEntryFieldReveal(event.target)
    }

    const handleViewportChange = () => {
      scheduleEntryFieldReveal()
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
  useEffect(() => { entriesRef.current = entries }, [entries])
  // entryId → timestamp of the last local write; used to ignore our own echoes.
  const recentLocalWrites = useRef<Map<string, number>>(new Map())
  // Always-current silent refetch of the visible page, called from WS handlers.
  const liveRefetchRef = useRef<() => void>(() => {})
  const liveRefetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const pageSize = entryPageSize === 'all' ? null : entryPageSize
  const entryTotalPages = pageSize ? Math.max(1, Math.ceil(entryTotal / pageSize)) : 1
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
  const allSelected = entries.length > 0 && selectedIds.length === entries.length
  const selectedCount = selectedIds.length
  const dragUnavailableReason = useMemo(() => {
    if (entrySortBy !== 'custom') return null
    if (entrySearchFilter.trim()) return te('clearSearchDrag')
    if (entryPageSize !== 'all') return te('switchAllDrag')
    return null
  }, [entrySortBy, entrySearchFilter, entryPageSize, te])
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

  const fetchAllEntries = useCallback(async (
    bookId: string,
    sortBy: WorldBookEntrySortBy,
    sortDir: WorldBookEntrySortDir,
    search: string,
  ) => {
    const chunkSize = sortBy === 'custom' ? CUSTOM_PAGE_SIZE : 200
    let offset = 0
    let total = 0
    const aggregated: WorldBookEntry[] = []

    do {
      const res = await worldBooksApi.listEntries(bookId, {
        limit: chunkSize,
        offset,
        sort_by: mapSortForApi(sortBy),
        sort_dir: sortBy === 'custom' ? 'asc' : sortDir,
        search: search || undefined,
      })
      aggregated.push(...res.data)
      total = res.total
      offset += res.data.length
      if (res.data.length === 0) break
    } while (offset < total)

    return { data: aggregated, total }
  }, [])

  const loadEntries = useCallback(async (
    bookId: string,
    page: number,
    sortBy: WorldBookEntrySortBy,
    sortDir: WorldBookEntrySortDir,
    search: string,
    nextPageSize: WorldBookEntryPageSize,
    opts?: { silent?: boolean },
  ) => {
    // Silent loads (live-sync refetches) skip the loading flash so they don't
    // momentarily unmount an expanded entry editor and drop in-progress text.
    const silent = opts?.silent ?? false
    if (!silent) setLoadingEntries(true)
    try {
      const res = nextPageSize === 'all'
        ? await fetchAllEntries(bookId, sortBy, sortDir, search)
        : await worldBooksApi.listEntries(bookId, {
            limit: nextPageSize,
            offset: (page - 1) * nextPageSize,
            sort_by: mapSortForApi(sortBy),
            sort_dir: sortBy === 'custom' ? 'asc' : sortDir,
            search: search || undefined,
          })
      setEntries(res.data)
      setEntryTotal(res.total)
      const totalPages = nextPageSize === 'all' ? 1 : Math.max(1, Math.ceil(res.total / nextPageSize))
      if (page > totalPages) {
        setEntryPage(totalPages)
      }
    } finally {
      if (!silent) setLoadingEntries(false)
    }
  }, [fetchAllEntries])

  useEffect(() => {
    const pref = worldBookEntryViewPrefs[selectedBookId] || {
      sortBy: 'custom' as const,
      sortDir: 'asc' as const,
      pageSize: DEFAULT_PAGE_SIZE,
    }
    setEntrySortBy(pref.sortBy)
    setEntrySortDir(pref.sortDir)
    setEntryPageSize(pref.pageSize || DEFAULT_PAGE_SIZE)
    setEntryPage(1)
    setEntrySearchFilter('')
    setMobileListOptionsOpen(false)
    setSelectedEntryId(null)
    setSelectMode(false)
    setSelectedIds([])
    setContextMenu(null)
    setTypeMenu(null)
    setPositionMenu(null)
  }, [selectedBookId, worldBookEntryViewPrefs])

  useEffect(() => {
    if (!selectedBookId) return
    const handle = setTimeout(() => {
      void loadEntries(selectedBookId, entryPage, entrySortBy, entrySortDir, entrySearchFilter.trim(), entryPageSize)
    }, 200)
    return () => clearTimeout(handle)
  }, [selectedBookId, entryPage, entrySortBy, entrySortDir, entrySearchFilter, entryPageSize, loadEntries])

  // Keep the silent-refetch closure current so the WS subscription (bound once
  // per book) always refetches the page/sort/filter the user is actually viewing.
  useEffect(() => {
    liveRefetchRef.current = () => {
      if (!selectedBookId) return
      void loadEntries(selectedBookId, entryPage, entrySortBy, entrySortDir, entrySearchFilter.trim(), entryPageSize, { silent: true })
    }
  })

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
      if (!entriesRef.current.some((e) => e.id === p.id)) {
        scheduleLiveRefetch()
        return
      }
      setEntries((cur) => cur.map((e) => (e.id === p.id ? p.entry : e)))
    })
    const offEntryDeleted = wsClient.on(EventType.WORLD_BOOK_ENTRY_DELETED, (p: WorldBookEntryDeletedPayload) => {
      if (!p?.id || p.worldBookId !== selectedBookId) return
      if (!entriesRef.current.some((e) => e.id === p.id)) return
      setEntries((cur) => cur.filter((e) => e.id !== p.id))
      setEntryTotal((tot) => Math.max(0, tot - 1))
      setSelectedEntryId((cur) => (cur === p.id ? null : cur))
      setSelectedIds((cur) => cur.filter((id) => id !== p.id))
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
  }, [selectedBookId, scheduleLiveRefetch])

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => entries.some((entry) => entry.id === id)))
  }, [entries])

  const refetchCurrentPage = useCallback(async () => {
    await loadEntries(selectedBookId, entryPage, entrySortBy, entrySortDir, entrySearchFilter.trim(), entryPageSize)
  }, [selectedBookId, entryPage, entrySortBy, entrySortDir, entrySearchFilter, entryPageSize, loadEntries])

  const updateEntry = useCallback((entryId: string, updates: Record<string, any>) => {
    setEntries((current) => current.map((entry) => (entry.id === entryId ? { ...entry, ...updates } : entry)))
    recentLocalWrites.current.set(entryId, Date.now())
    void worldBooksApi.updateEntry(selectedBookId, entryId, updates)
      .then(async () => {
        await refreshVectorSummary()
      })
      .catch(() => {
        void refetchCurrentPage()
      })
  }, [selectedBookId, refreshVectorSummary, refetchCurrentPage])

  const debouncedUpdateEntry = useCallback((entryId: string, updates: Record<string, any>) => {
    setEntries((current) => current.map((entry) => (entry.id === entryId ? { ...entry, ...updates } : entry)))
    recentLocalWrites.current.set(entryId, Date.now())
    const key = `${entryId}:${Object.keys(updates).sort().join(',')}`
    clearTimeout(entryTimers.current[key])
    entryTimers.current[key] = setTimeout(() => {
      void worldBooksApi.updateEntry(selectedBookId, entryId, updates)
        .then(async () => {
          await refreshVectorSummary()
        })
        .catch(() => {
          void refetchCurrentPage()
        })
    }, 400)
  }, [selectedBookId, refreshVectorSummary, refetchCurrentPage])

  const handleCreateEntry = useCallback(async () => {
    const entry = await worldBooksApi.createEntry(selectedBookId, {
      comment: t('defaultEntryComment'),
      key: [],
      content: '',
    })
    recentLocalWrites.current.set(entry.id, Date.now())
    setSelectedEntryId(entry.id)
    setEntryPage(1)
    await loadEntries(selectedBookId, 1, entrySortBy, entrySortDir, entrySearchFilter.trim(), entryPageSize)
    await refreshVectorSummary()
  }, [selectedBookId, entrySortBy, entrySortDir, entrySearchFilter, entryPageSize, loadEntries, refreshVectorSummary, t])

  const handleDeleteEntries = useCallback(async (entryIds: string[]) => {
    if (entryIds.length === 1) {
      await worldBooksApi.deleteEntry(selectedBookId, entryIds[0])
    } else {
      await worldBooksApi.bulkEntryAction(selectedBookId, { action: 'delete', entry_ids: entryIds })
    }
    setSelectedEntryId((current) => (current && entryIds.includes(current) ? null : current))
    setSelectedIds((current) => current.filter((id) => !entryIds.includes(id)))
    await refetchCurrentPage()
    await refreshVectorSummary()
  }, [selectedBookId, refetchCurrentPage, refreshVectorSummary])

  const handleDuplicateHere = useCallback(async (entryId: string) => {
    await worldBooksApi.duplicateEntry(selectedBookId, entryId)
    await refetchCurrentPage()
    await refreshVectorSummary()
  }, [selectedBookId, refetchCurrentPage, refreshVectorSummary])

  const handleMoveOrCopy = useCallback(async () => {
    if (!moveCopyState || !moveTargetBookId) return
    setPendingAction(true)
    try {
      if (moveCopyState.mode === 'move') {
        await worldBooksApi.bulkEntryAction(selectedBookId, {
          action: 'move',
          entry_ids: moveCopyState.entryIds,
          target_book_id: moveTargetBookId,
        })
        setSelectedIds((current) => current.filter((id) => !moveCopyState.entryIds.includes(id)))
      } else {
        await Promise.all(moveCopyState.entryIds.map((entryId) =>
          worldBooksApi.duplicateEntry(selectedBookId, entryId, { target_book_id: moveTargetBookId })
        ))
      }
      setMoveCopyState(null)
      setMoveTargetBookId('')
      await refetchCurrentPage()
      await refreshVectorSummary()
    } finally {
      setPendingAction(false)
    }
  }, [moveCopyState, moveTargetBookId, selectedBookId, refetchCurrentPage, refreshVectorSummary])

  const handleBulkRenumber = useCallback(async () => {
    if (!renumberState) return
    setPendingAction(true)
    try {
      const payload: WorldBookEntryBulkActionInput = {
        action: 'renumber',
        entry_ids: renumberState.entryIds,
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
    } finally {
      setPendingAction(false)
    }
  }, [renumberDirection, renumberStart, renumberState, renumberStep, selectedBookId, refetchCurrentPage])

  const handleBulkKeyword = useCallback(async () => {
    if (!keywordState || !keywordValue.trim()) return
    setPendingAction(true)
    try {
      await worldBooksApi.bulkEntryAction(selectedBookId, {
        action: 'add_keyword',
        entry_ids: keywordState.entryIds,
        keyword: keywordValue.trim(),
        target: keywordTarget,
      })
      setKeywordState(null)
      setKeywordValue('')
      setKeywordTarget('primary')
      await refetchCurrentPage()
      await refreshVectorSummary()
    } finally {
      setPendingAction(false)
    }
  }, [keywordState, keywordValue, keywordTarget, selectedBookId, refetchCurrentPage, refreshVectorSummary])

  const handleBulkSetPosition = useCallback(async () => {
    if (!positionState) return
    setPendingAction(true)
    try {
      const payload: WorldBookEntryBulkActionInput = {
        action: 'set_position',
        entry_ids: positionState.entryIds,
        position: bulkPosition,
        ...(bulkPosition === 4 ? { depth: Math.max(0, parseInt(bulkDepth, 10) || 4) } : {}),
      }
      await worldBooksApi.bulkEntryAction(selectedBookId, payload)
      setPositionState(null)
      setBulkPosition(0)
      setBulkDepth('4')
      await refetchCurrentPage()
    } finally {
      setPendingAction(false)
    }
  }, [positionState, bulkPosition, bulkDepth, selectedBookId, refetchCurrentPage])

  const handleToggleSelect = useCallback((entryId: string) => {
    setSelectedIds((current) => (
      current.includes(entryId)
        ? current.filter((id) => id !== entryId)
        : [...current, entryId]
    ))
  }, [])

  const handleSelectAllVisible = useCallback(() => {
    setSelectedIds((current) => {
      if (current.length === entries.length) return []
      return entries.map((entry) => entry.id)
    })
  }, [entries])

  const handleSortByChange = useCallback((value: WorldBookEntrySortBy) => {
    const next = {
      sortBy: value,
      sortDir: value === 'custom' ? 'asc' as const : entrySortDir,
      pageSize: value === 'custom' ? 'all' as const : entryPageSize,
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
    const oldIndex = entries.findIndex((entry) => entry.id === active.id)
    const newIndex = entries.findIndex((entry) => entry.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const nextEntries = arrayMove(entries, oldIndex, newIndex)
    setEntries(nextEntries)
    try {
      await worldBooksApi.reorderEntries(selectedBookId, { ordered_ids: nextEntries.map((entry) => entry.id) })
      await refetchCurrentPage()
    } catch {
      await refetchCurrentPage()
    }
  }, [dragEnabled, entries, selectedBookId, refetchCurrentPage])

  const selectedEntry = contextMenu ? entries.find((entry) => entry.id === contextMenu.entryId) ?? null : null
  const selectedTypeEntry = typeMenu ? entries.find((entry) => entry.id === typeMenu.entryId) ?? null : null
  const selectedPositionEntry = positionMenu ? entries.find((entry) => entry.id === positionMenu.entryId) ?? null : null
  const activeDragEntry = activeDragId ? entries.find((entry) => entry.id === activeDragId) ?? null : null
  const contextMenuItems: ContextMenuEntry[] = selectedEntry
    ? [
        {
          key: 'expand',
          label: selectedEntryId === selectedEntry.id ? te('contextCollapseEditor') : te('contextExpandEditor'),
          onClick: () => {
            setSelectedEntryId((current) => (current === selectedEntry.id ? null : selectedEntry.id))
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
            setMoveTargetBookId('')
            setMoveCopyState({
              mode: 'move',
              entryIds: [selectedEntry.id],
              title: te('moveEntryTitle'),
              confirmText: te('move'),
            })
          },
          disabled: availableTargetBooks.length === 0,
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
  const paginationControls = entryPageSize !== 'all' && entryTotalPages > 1 ? (
    <Pagination
      className={styles.entryPaginationControls}
      currentPage={entryPage}
      totalPages={entryTotalPages}
      onPageChange={(page) => {
        setEntryPage(page)
        setSelectedEntryId(null)
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
      )}
    >
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
          <button type="button" className={styles.newEntryBtn} onClick={() => void handleCreateEntry()}>
            <Plus size={12} />
            <span>{te('newEntry')}</span>
          </button>
        </div>
      </div>

      <div className={clsx(styles.entrySearchRow, isMobile && styles.entrySearchRowMobile)}>
        <label className={styles.entrySearch}>
          <Search size={14} className={styles.entrySearchIcon} />
          <input
            type="text"
            className={styles.entrySearchInput}
            placeholder={te('searchAll')}
            value={entrySearchFilter}
            onChange={(e) => {
              setEntrySearchFilter(e.target.value)
              setEntryPage(1)
              setSelectedEntryId(null)
            }}
          />
        </label>
        {isMobile && (
          <button
            type="button"
            className={clsx(styles.listOptionsToggle, mobileListOptionsOpen && styles.listOptionsToggleActive)}
            onClick={() => setMobileListOptionsOpen((current) => !current)}
            aria-expanded={mobileListOptionsOpen}
            title={te('sortBy')}
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
            {labels.pageSizeOptions.map((option) => (
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

      {dragUnavailableReason && (!isMobile || mobileListOptionsOpen) && (
        <div className={styles.customSortHint}>
          <Hash size={12} />
          <span>{dragUnavailableReason}</span>
        </div>
      )}

      {selectMode && (
        <div className={styles.bulkBar}>
          <div className={styles.bulkLeft}>
            <button type="button" className={styles.bulkToggle} onClick={handleSelectAllVisible}>
              {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
            </button>
            <span className={styles.bulkCount}>{te('bulkSelected', { selected: selectedCount, total: entries.length })}</span>
          </div>
          <div className={styles.bulkActions}>
            <button
              type="button"
              className={styles.bulkActionBtn}
              disabled={selectedCount === 0 || availableTargetBooks.length === 0}
              onClick={() => {
                setMoveTargetBookId('')
                setMoveCopyState({
                  mode: 'move',
                  entryIds: selectedIds,
                  title: te('moveCount', { count: selectedCount }),
                  confirmText: te('move'),
                })
              }}
            >
              <MoveRight size={13} />
              <span>{te('move')}</span>
            </button>
            <button
              type="button"
              className={styles.bulkActionBtn}
              disabled={selectedCount === 0}
              onClick={() => {
                setRenumberStart('')
                setRenumberStep('1')
                setRenumberDirection('asc')
                setRenumberState({ entryIds: selectedIds })
              }}
            >
              <Hash size={13} />
              <span>{te('renumber')}</span>
            </button>
            <button
              type="button"
              className={styles.bulkActionBtn}
              disabled={selectedCount === 0}
              onClick={() => {
                setKeywordValue('')
                setKeywordTarget('primary')
                setKeywordState({ entryIds: selectedIds })
              }}
            >
              <Tag size={13} />
              <span>{te('addKeyword')}</span>
            </button>
            <button
              type="button"
              className={styles.bulkActionBtn}
              disabled={selectedCount === 0}
              onClick={() => {
                setBulkPosition(0)
                setBulkDepth('4')
                setPositionState({ entryIds: selectedIds })
              }}
            >
              <MapPin size={13} />
              <span>Set Position</span>
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
            <SortableContext items={entries.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
              <div
                ref={usesSharedScroll ? undefined : localScrollRef}
                className={clsx(styles.entryScroll, usesSharedScroll && styles.entryScrollShared)}
              >
                <div className={styles.entryList}>
                  {entries.length === 0 ? (
                    <div className={styles.emptyState}>
                      {entrySearchFilter.trim() ? te('noMatch') : te('empty')}
                    </div>
                  ) : (
                    entries.map((entry, index) => (
                      <div
                        key={entry.id}
                        data-index={index}
                        data-entry-id={entry.id}
                        className={styles.entryListItem}
                      >
                        <EntryRow
                          entry={entry}
                          expanded={selectedEntryId === entry.id}
                          dragEnabled={dragEnabled}
                          selectMode={selectMode}
                          selected={selectedIds.includes(entry.id)}
                          onToggleExpand={() => setSelectedEntryId((current) => (current === entry.id ? null : entry.id))}
                          onToggleSelect={() => handleToggleSelect(entry.id)}
                          onUpdate={updateEntry}
                          onDebouncedUpdate={debouncedUpdateEntry}
                          onOpenMenu={(entryId, position) => setContextMenu({ entryId, position })}
                          onOpenTypeMenu={(entryId, position) => setTypeMenu({ entryId, position })}
                          onOpenPositionMenu={(entryId, position) => setPositionMenu({ entryId, position })}
                        />
                      </div>
                    ))
                  )}
                </div>
              </div>
            </SortableContext>
            <DragOverlay dropAnimation={null}>
              {activeDragEntry && (
                <EntryRowContent
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
        <ModalShell isOpen={true} onClose={() => !pendingAction && setMoveCopyState(null)} maxWidth="520px">
          <div className={styles.dialogBody}>
            <h3 className={styles.dialogTitle}>{moveCopyState.title}</h3>
            <p className={styles.dialogText}>
              {selectedBook ? te('moveCopyFrom', { name: selectedBook.name }) : null}
            </p>
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
            <div className={styles.dialogActions}>
              <Button variant="secondary" onClick={() => setMoveCopyState(null)} disabled={pendingAction}>{tc('actions.cancel')}</Button>
              <Button variant="primary" onClick={() => void handleMoveOrCopy()} disabled={pendingAction || !moveTargetBookId}>
                {moveCopyState.confirmText}
              </Button>
            </div>
          </div>
        </ModalShell>
      )}
      {dockedPagination}

      {renumberState && (
        <ModalShell isOpen={true} onClose={() => !pendingAction && setRenumberState(null)} maxWidth="520px">
          <div className={styles.dialogBody}>
            <h3 className={styles.dialogTitle}>{te('renumberTitle')}</h3>
            <p className={styles.dialogText}>{te('renumberHint')}</p>
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
            <div className={styles.dialogActions}>
              <Button variant="secondary" onClick={() => setRenumberState(null)} disabled={pendingAction}>{tc('actions.cancel')}</Button>
              <Button variant="primary" onClick={() => void handleBulkRenumber()} disabled={pendingAction}>{tc('actions.apply')}</Button>
            </div>
          </div>
        </ModalShell>
      )}

      {keywordState && (
        <ModalShell isOpen={true} onClose={() => !pendingAction && setKeywordState(null)} maxWidth="520px">
          <div className={styles.dialogBody}>
            <h3 className={styles.dialogTitle}>{te('keywordTitle')}</h3>
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
            <div className={styles.dialogActions}>
              <Button variant="secondary" onClick={() => setKeywordState(null)} disabled={pendingAction}>{tc('actions.cancel')}</Button>
              <Button variant="primary" onClick={() => void handleBulkKeyword()} disabled={pendingAction || !keywordValue.trim()}>{tc('actions.add')}</Button>
            </div>
          </div>
        </ModalShell>
      )}

      {positionState && (
        <ModalShell isOpen={true} onClose={() => !pendingAction && setPositionState(null)} maxWidth="520px">
          <div className={styles.dialogBody}>
            <h3 className={styles.dialogTitle}>{te('setPositionTitle')}</h3>
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
            <div className={styles.dialogActions}>
              <Button variant="secondary" onClick={() => setPositionState(null)} disabled={pendingAction}>{tc('actions.cancel')}</Button>
              <Button variant="primary" onClick={() => void handleBulkSetPosition()} disabled={pendingAction}>{tc('actions.apply')}</Button>
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  )
}
