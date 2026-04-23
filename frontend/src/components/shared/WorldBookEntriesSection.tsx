import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  Zap,
} from 'lucide-react'
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import clsx from 'clsx'
import { worldBooksApi } from '@/api/world-books'
import WorldBookEntryEditor from '@/components/shared/WorldBookEntryEditor'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import SearchableSelect from '@/components/shared/SearchableSelect'
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

const POSITION_SHORT = ['Before Main', 'After Main', 'Before AN', 'After AN', '@ Depth']
const POSITION_OPTIONS = [
  { value: 0, label: 'Before Main' },
  { value: 1, label: 'After Main' },
  { value: 2, label: 'Before AN' },
  { value: 3, label: 'After AN' },
  { value: 4, label: 'At Depth' },
] as const
const TYPE_OPTIONS = [
  { value: 'trigger', label: 'Trigger' },
  { value: 'constant', label: 'Constant' },
  { value: 'vector', label: 'Vector' },
] as const
const SORT_OPTIONS: { value: WorldBookEntrySortBy; label: string }[] = [
  { value: 'custom', label: 'Custom' },
  { value: 'priority', label: 'Priority' },
  { value: 'name', label: 'Name' },
  { value: 'created', label: 'Date Created' },
  { value: 'updated', label: 'Last Updated' },
]
const PAGE_SIZE_OPTIONS: Array<{ value: WorldBookEntryPageSize; label: string }> = [
  { value: 50, label: '50 / page' },
  { value: 100, label: '100 / page' },
  { value: 200, label: '200 / page' },
  { value: 'all', label: 'All entries' },
]
const DEFAULT_PAGE_SIZE = 50 as const
const CUSTOM_PAGE_SIZE = 200 as const

function mapSortForApi(sortBy: WorldBookEntrySortBy): 'order' | 'priority' | 'created' | 'updated' | 'name' {
  return sortBy === 'custom' ? 'order' : sortBy
}

function getEntryType(entry: WorldBookEntry): 'trigger' | 'constant' | 'vector' {
  if (entry.constant) return 'constant'
  if (entry.vectorized) return 'vector'
  return 'trigger'
}

function formatEntryCount(count: number): string {
  return `${count} entr${count === 1 ? 'y' : 'ies'}`
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

function SortableEntryRow({
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
}: EntryRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
    disabled: !dragEnabled,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const controlWrapProps = {
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  }

  return (
    <div ref={setNodeRef} style={style} className={clsx(isDragging && styles.rowDragging)}>
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
                aria-label={selected ? 'Deselect entry' : 'Select entry'}
              />
            ) : (
              <input
                type="checkbox"
                className={styles.enableToggle}
                checked={!entry.disabled}
                title={entry.disabled ? 'Disabled' : 'Enabled'}
                onChange={() => onUpdate(entry.id, { disabled: !entry.disabled })}
                aria-label={entry.disabled ? 'Enable entry' : 'Disable entry'}
              />
            )}
            <button
              type="button"
              className={clsx(styles.dragHandle, !dragEnabled && styles.dragHandleDisabled)}
              title={dragEnabled ? 'Drag to reorder' : 'Custom drag reorder unavailable'}
              aria-label="Drag handle"
              tabIndex={-1}
              {...attributes}
              {...listeners}
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
                  title="Change entry type"
                  aria-label={`Change entry type from ${getEntryType(entry)}`}
                >
                  <span>{entry.constant ? 'Constant' : entry.vectorized ? 'Vector' : 'Trigger'}</span>
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
                  title="Change entry position"
                  aria-label={`Change entry position from ${POSITION_SHORT[entry.position] ?? `Pos ${entry.position}`}`}
                >
                  <span>{POSITION_SHORT[entry.position] ?? `Pos ${entry.position}`}</span>
                  <ChevronDown size={11} />
                </button>
              </div>
            </div>

            <div className={styles.entryActions} {...controlWrapProps}>
            <button
              type="button"
              className={styles.expandBtn}
              onClick={onToggleExpand}
              title={expanded ? 'Collapse entry editor' : 'Expand entry editor'}
              aria-label={expanded ? 'Collapse entry editor' : 'Expand entry editor'}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span>{expanded ? 'Collapse' : 'Expand'}</span>
            </button>
            <button
              type="button"
              className={styles.moreBtn}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                onOpenMenu(entry.id, { x: rect.right, y: rect.bottom + 4 })
              }}
              title="More actions"
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
}

export default function WorldBookEntriesSection({
  books,
  selectedBookId,
  onRefreshVectorSummary,
}: WorldBookEntriesSectionProps) {
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
  const [pendingAction, setPendingAction] = useState(false)
  const entryTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const pageSize = entryPageSize === 'all' ? null : entryPageSize
  const entryTotalPages = pageSize ? Math.max(1, Math.ceil(entryTotal / pageSize)) : 1
  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? null,
    [books, selectedBookId],
  )
  const availableTargetBooks = useMemo(
    () => books.filter((book) => book.id !== selectedBookId).map((book) => ({ value: book.id, label: book.name })),
    [books, selectedBookId],
  )
  const allSelected = entries.length > 0 && selectedIds.length === entries.length
  const selectedCount = selectedIds.length
  const dragUnavailableReason = useMemo(() => {
    if (entrySortBy !== 'custom') return null
    if (entrySearchFilter.trim()) return 'Clear search to drag-reorder entries.'
    if (entryPageSize !== 'all') return 'Switch page size to All entries to drag-reorder without pagination.'
    return null
  }, [entrySortBy, entrySearchFilter, entryPageSize])
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
  ) => {
    setLoadingEntries(true)
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
      setLoadingEntries(false)
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

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => entries.some((entry) => entry.id === id)))
  }, [entries])

  const refetchCurrentPage = useCallback(async () => {
    await loadEntries(selectedBookId, entryPage, entrySortBy, entrySortDir, entrySearchFilter.trim(), entryPageSize)
  }, [selectedBookId, entryPage, entrySortBy, entrySortDir, entrySearchFilter, entryPageSize, loadEntries])

  const updateEntry = useCallback((entryId: string, updates: Record<string, any>) => {
    setEntries((current) => current.map((entry) => (entry.id === entryId ? { ...entry, ...updates } : entry)))
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
      comment: 'New Entry',
      key: [],
      content: '',
    })
    setSelectedEntryId(entry.id)
    setEntryPage(1)
    await loadEntries(selectedBookId, 1, entrySortBy, entrySortDir, entrySearchFilter.trim(), entryPageSize)
    await refreshVectorSummary()
  }, [selectedBookId, entrySortBy, entrySortDir, entrySearchFilter, entryPageSize, loadEntries, refreshVectorSummary])

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

  const handleDragEnd = useCallback(async ({ active, over }: any) => {
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
  const contextMenuItems: ContextMenuEntry[] = selectedEntry
    ? [
        {
          key: 'expand',
          label: selectedEntryId === selectedEntry.id ? 'Collapse editor' : 'Expand editor',
          onClick: () => {
            setSelectedEntryId((current) => (current === selectedEntry.id ? null : selectedEntry.id))
            setContextMenu(null)
          },
        },
        {
          key: 'duplicate',
          label: 'Duplicate here',
          icon: <Copy size={14} />,
          onClick: () => {
            setContextMenu(null)
            void handleDuplicateHere(selectedEntry.id)
          },
        },
        {
          key: 'copy',
          label: 'Copy to book…',
          icon: <Copy size={14} />,
          onClick: () => {
            setContextMenu(null)
            setMoveTargetBookId('')
            setMoveCopyState({
              mode: 'copy',
              entryIds: [selectedEntry.id],
              title: 'Copy Entry',
              confirmText: 'Copy',
            })
          },
          disabled: availableTargetBooks.length === 0,
        },
        {
          key: 'move',
          label: 'Move to book…',
          icon: <MoveRight size={14} />,
          onClick: () => {
            setContextMenu(null)
            setMoveTargetBookId('')
            setMoveCopyState({
              mode: 'move',
              entryIds: [selectedEntry.id],
              title: 'Move Entry',
              confirmText: 'Move',
            })
          },
          disabled: availableTargetBooks.length === 0,
        },
        { key: 'divider', type: 'divider' },
        {
          key: 'delete',
          label: 'Delete',
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: () => {
            setContextMenu(null)
            setDeleteState({
              entryIds: [selectedEntry.id],
              title: 'Delete Entry',
              message: 'Delete this entry? This cannot be undone.',
            })
          },
        },
      ]
    : []
  const typeMenuItems: ContextMenuEntry[] = selectedTypeEntry
    ? TYPE_OPTIONS.map((option) => ({
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
    ? POSITION_OPTIONS.map((option) => ({
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
                : <Hash size={14} />,
        active: selectedPositionEntry.position === option.value,
        onClick: () => {
          updateEntry(selectedPositionEntry.id, { position: option.value })
          setPositionMenu(null)
        },
      }))
    : []

  return (
    <>
      <div className={styles.entryListHeader}>
        <span className={styles.entryListTitle}>Entries ({entryTotal})</span>
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
            title={selectMode ? 'Exit bulk select' : 'Bulk select'}
          >
            {selectMode ? <CheckSquare size={13} /> : <Square size={13} />}
            <span>Select</span>
          </button>
          <button type="button" className={styles.newEntryBtn} onClick={() => void handleCreateEntry()}>
            <Plus size={12} />
            <span>New Entry</span>
          </button>
        </div>
      </div>

      <div className={styles.entrySortRow}>
        <select
          className={styles.entrySortSelect}
          value={entrySortBy}
          onChange={(e) => handleSortByChange(e.target.value as WorldBookEntrySortBy)}
          title="Sort entries by"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>Sort: {option.label}</option>
          ))}
        </select>
        <select
          className={styles.entryPageSizeSelect}
          value={String(entryPageSize)}
          onChange={(e) => handlePageSizeChange(e.target.value)}
          title="Entries per page"
        >
          {PAGE_SIZE_OPTIONS.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
          ))}
        </select>
        {entrySortBy !== 'custom' && (
          <button
            type="button"
            className={styles.entrySortDirBtn}
            onClick={handleToggleSortDir}
            title={entrySortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
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
          placeholder="Search all entries..."
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
            <span className={styles.bulkCount}>{selectedCount} of {entries.length} selected</span>
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
                  title: `Move ${formatEntryCount(selectedCount)}`,
                  confirmText: 'Move',
                })
              }}
            >
              <MoveRight size={13} />
              <span>Move</span>
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
              <span>Renumber</span>
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
              <span>Add Keyword</span>
            </button>
            <button
              type="button"
              className={clsx(styles.bulkActionBtn, styles.bulkDeleteBtn)}
              disabled={selectedCount === 0}
              onClick={() => {
                setDeleteState({
                  entryIds: selectedIds,
                  title: 'Delete Entries',
                  message: `Delete ${formatEntryCount(selectedCount)}? This cannot be undone.`,
                })
              }}
            >
              <Trash2 size={13} />
              <span>Delete</span>
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
              <span>Cancel</span>
            </button>
          </div>
        </div>
      )}

      {loadingEntries ? (
        <div className={styles.emptyState}>Loading entries...</div>
      ) : (
        <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={entries.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
              <div className={styles.entryList}>
                {entries.map((entry) => (
                  <SortableEntryRow
                    key={entry.id}
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
                ))}
                {entries.length === 0 && (
                  <div className={styles.emptyState}>
                    {entrySearchFilter.trim() ? 'No entries match your search' : 'No entries yet'}
                  </div>
                )}
              </div>
            </SortableContext>
          </DndContext>

          {entryPageSize !== 'all' && entryTotalPages > 1 && (
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
          confirmText="Delete"
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
              {selectedBook ? `From ${selectedBook.name}.` : null}
            </p>
            <div className={styles.dialogField}>
              <span className={styles.dialogLabel}>Target World Book</span>
              <SearchableSelect
                value={moveTargetBookId}
                onChange={(value) => setMoveTargetBookId(value || '')}
                options={availableTargetBooks}
                placeholder="Choose a world book…"
                searchPlaceholder="Search world books…"
                emptyMessage="No other world books available"
                portal
              />
            </div>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.dialogBtn} onClick={() => setMoveCopyState(null)} disabled={pendingAction}>Cancel</button>
              <button type="button" className={styles.dialogPrimaryBtn} onClick={() => void handleMoveOrCopy()} disabled={pendingAction || !moveTargetBookId}>
                {moveCopyState.confirmText}
              </button>
            </div>
          </div>
        </ModalShell>
      )}

      {renumberState && (
        <ModalShell isOpen={true} onClose={() => !pendingAction && setRenumberState(null)} maxWidth="520px">
          <div className={styles.dialogBody}>
            <h3 className={styles.dialogTitle}>Renumber Entries</h3>
            <p className={styles.dialogText}>Applies numbering in the current list order.</p>
            <div className={styles.dialogGrid}>
              <label className={styles.dialogField}>
                <span className={styles.dialogLabel}>Start Number</span>
                <input
                  type="number"
                  className={styles.dialogInput}
                  value={renumberStart}
                  onChange={(e) => setRenumberStart(e.target.value)}
                  placeholder="Use first entry's order"
                />
              </label>
              <label className={styles.dialogField}>
                <span className={styles.dialogLabel}>Step</span>
                <input
                  type="number"
                  min={1}
                  className={styles.dialogInput}
                  value={renumberStep}
                  onChange={(e) => setRenumberStep(e.target.value)}
                />
              </label>
              <label className={styles.dialogField}>
                <span className={styles.dialogLabel}>Direction</span>
                <select className={styles.dialogSelect} value={renumberDirection} onChange={(e) => setRenumberDirection(e.target.value as 'asc' | 'desc')}>
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
              </label>
            </div>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.dialogBtn} onClick={() => setRenumberState(null)} disabled={pendingAction}>Cancel</button>
              <button type="button" className={styles.dialogPrimaryBtn} onClick={() => void handleBulkRenumber()} disabled={pendingAction}>Apply</button>
            </div>
          </div>
        </ModalShell>
      )}

      {keywordState && (
        <ModalShell isOpen={true} onClose={() => !pendingAction && setKeywordState(null)} maxWidth="520px">
          <div className={styles.dialogBody}>
            <h3 className={styles.dialogTitle}>Add Keyword</h3>
            <div className={styles.dialogGrid}>
              <label className={styles.dialogField}>
                <span className={styles.dialogLabel}>Keyword</span>
                <input
                  type="text"
                  className={styles.dialogInput}
                  value={keywordValue}
                  onChange={(e) => setKeywordValue(e.target.value)}
                  placeholder="Enter keyword"
                />
              </label>
              <label className={styles.dialogField}>
                <span className={styles.dialogLabel}>Keyword List</span>
                <select className={styles.dialogSelect} value={keywordTarget} onChange={(e) => setKeywordTarget(e.target.value as 'primary' | 'secondary')}>
                  <option value="primary">Primary</option>
                  <option value="secondary">Secondary</option>
                </select>
              </label>
            </div>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.dialogBtn} onClick={() => setKeywordState(null)} disabled={pendingAction}>Cancel</button>
              <button type="button" className={styles.dialogPrimaryBtn} onClick={() => void handleBulkKeyword()} disabled={pendingAction || !keywordValue.trim()}>Add</button>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  )
}
