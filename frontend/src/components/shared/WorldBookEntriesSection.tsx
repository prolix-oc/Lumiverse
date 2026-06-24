import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorldBookEntryLabels } from '@/lib/i18n/worldBookEntryLabels'
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
import { useVirtualizer, defaultRangeExtractor, type Range } from '@tanstack/react-virtual'
import { useScaledSortableStyle } from '@/lib/dndUiScale'
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

/** Ignore WORLD_BOOK_ENTRY_CHANGED echoes of our own writes for this long. */
const SELF_ECHO_WINDOW_MS = 2_000

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
                  <span>{labels.positionLabel(entry.position)}</span>
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
  scrollElementRef?: React.RefObject<HTMLElement | null>
}

export default function WorldBookEntriesSection({
  books,
  selectedBookId,
  onRefreshVectorSummary,
  scrollElementRef,
}: WorldBookEntriesSectionProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel' })
  const { t: te } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entries' })
  const { t: tc } = useTranslation('common')
  const labels = useWorldBookEntryLabels()
  const formatEntryCount = useFormatEntryCount()
  const worldBookEntryViewPrefs = useStore((s) => s.worldBookEntryViewPrefs)
  const setSetting = useStore((s) => s.setSetting)

  const [entries, setEntries] = useState<WorldBookEntry[]>([])
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [entryTotal, setEntryTotal] = useState(0)
  const [entryPage, setEntryPage] = useState(1)
  const [loadingEntries, setLoadingEntries] = useState(false)
  const [entrySearchFilter, setEntrySearchFilter] = useState('')
  const [entrySortBy, setEntrySortBy] = useState<WorldBookEntrySortBy>('custom')
  const [entrySortDir, setEntrySortDir] = useState<WorldBookEntrySortDir>('asc')
  const [entryPageSize, setEntryPageSize] = useState<WorldBookEntryPageSize>(DEFAULT_PAGE_SIZE)
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
  const entryListRef = useRef<HTMLDivElement>(null)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)

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
  const allSelected = entries.length > 0 && selectedIds.length === entries.length
  const selectedCount = selectedIds.length
  const dragUnavailableReason = useMemo(() => {
    if (entrySortBy !== 'custom') return null
    if (entrySearchFilter.trim()) return te('clearSearchDrag')
    if (entryPageSize !== 'all') return te('switchAllDrag')
    return null
  }, [entrySortBy, entrySearchFilter, entryPageSize, te])
  const dragEnabled = entrySortBy === 'custom' && !dragUnavailableReason

  const rangeExtractor = useCallback((range: Range) => {
    // Drag-and-drop needs every sortable item mounted so @dnd-kit can
    // measure/position the list. Fall back to the full range in custom-sort
    // mode; otherwise virtualize normally.
    if (dragEnabled) {
      return Array.from({ length: range.count }, (_, i) => i)
    }
    return defaultRangeExtractor(range)
  }, [dragEnabled])

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const entryVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollElementRef?.current ?? entryListRef.current,
    estimateSize: () => 72,
    overscan: 6,
    getItemKey: (index) => entries[index]?.id ?? index,
    rangeExtractor,
    measureElement: (element) => {
      const size = element.getBoundingClientRect().height
      return Math.max(1, Number.isFinite(size) ? size : 72)
    },
  })

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
                  : <Hash size={14} />,
        active: selectedPositionEntry.position === option.value,
        onClick: () => {
          updateEntry(selectedPositionEntry.id, { position: option.value })
          setPositionMenu(null)
        },
      }))
    : []

  return (
    <div className={styles.section}>
      <div className={styles.entryListHeader}>
        <span className={styles.entryListTitle}>{te('entriesTitle', { count: entryTotal })}</span>
        <div className={styles.toolbarActions}>
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

      <div className={styles.entrySortRow}>
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

      {dragUnavailableReason && (
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
              <div ref={entryListRef} className={styles.entryList}>
                {entries.length === 0 ? (
                  <div className={styles.emptyState}>
                    {entrySearchFilter.trim() ? te('noMatch') : te('empty')}
                  </div>
                ) : (
                  <div
                    style={{
                      height: entryVirtualizer.getTotalSize(),
                      position: 'relative',
                    }}
                  >
                    {entryVirtualizer.getVirtualItems().map((virtualRow) => {
                      const entry = entries[virtualRow.index]
                      if (!entry) return null
                      return (
                        <div
                          key={virtualRow.key}
                          data-index={virtualRow.index}
                          data-entry-id={entry.id}
                          ref={entryVirtualizer.measureElement}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            paddingBottom: 8,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          <SortableEntryRow
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
                      )
                    })}
                  </div>
                )}
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

          {entryPageSize !== 'all' && entryTotalPages > 1 && (
            <div className={styles.entryPagination}>
              <Pagination
                currentPage={entryPage}
                totalPages={entryTotalPages}
                onPageChange={(page) => {
                  setEntryPage(page)
                  setSelectedEntryId(null)
                  setSelectedIds([])
                }}
                totalItems={entryTotal}
              />
            </div>
          )}
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
