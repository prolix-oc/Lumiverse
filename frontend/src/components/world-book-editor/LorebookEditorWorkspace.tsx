import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  BookOpen,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { ApiError } from '@/api/client'
import { worldBooksApi } from '@/api/world-books'
import {
  backfillEntryMetadata,
  buildEntryGridTemplate,
  buildEntryTableMinWidth,
  ENTRY_METADATA_VERSION,
  resolveVisibleColumns,
} from '@/lib/lorebookEntryColumns'
import { filterBooks } from '@/lib/lorebookBookSearch'
import { createEntrySearchIndex, searchEntriesByQuery } from '@/lib/lorebookEntrySearch'
import { runLorebookReorderIfCurrent } from '@/lib/lorebookMutationGuard'
import {
  buildBulkFieldPatch,
  EMPTY_BULK_FIELD_FORM,
  hasBulkFieldMutation,
  type BulkEnabledSelection,
  type BulkFieldForm,
  type BulkPositionSelection,
  type BulkTriggerSelection,
} from '@/lib/lorebookBulkPatch'
import { arrayMove } from '@dnd-kit/sortable'
import { useLorebookTokenCounts } from './useLorebookTokenCounts'
import { useLorebookEditorLayoutSettings } from './useLorebookEditorLayoutSettings'
import type {
  WorldBook,
  WorldBookEntry,
  WorldBookEntryBulkActionInput,
  WorldBookEntryConflictPayload,
} from '@/types/api'
import WorldBookEntryEditor from '@/components/shared/WorldBookEntryEditor'
import EntriesToolbar from './EntriesToolbar'
import EntryTable, { getTriggerType, type TriggerType } from './EntryTable'
import styles from './LorebookEditorLayout.module.css'

type WorkspaceVariant = 'full' | 'half'

export interface LorebookEditorWorkspaceProps {
  variant: WorkspaceVariant
  initialBookId?: string | null
  initialEntryId?: string | null
  onClose?: () => void
  onOpenFullEditor?: (bookId: string | null, entryId: string | null) => void
  onImportRequest?: () => void
  fullscreen?: boolean
  onToggleFullscreen?: () => void
}

interface EntryConflictState {
  server: WorldBookEntry
  draft: Partial<WorldBookEntry>
}

type BulkMutationInput = WorldBookEntryBulkActionInput extends infer Input
  ? Input extends WorldBookEntryBulkActionInput
    ? Omit<Input, 'expected_revisions'>
    : never
  : never

function expectedRevisionMap(entries: WorldBookEntry[], ids: string[]): Record<string, number> {
  const wanted = new Set(ids)
  return Object.fromEntries(
    entries.filter((entry) => wanted.has(entry.id)).map((entry) => [entry.id, entry.revision]),
  )
}

function conflictPayload(error: unknown): WorldBookEntryConflictPayload | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  if (error.body?.error !== 'world_book_entry_conflict' || !Array.isArray(error.body?.conflicts)) return null
  return error.body as WorldBookEntryConflictPayload
}

export default function LorebookEditorWorkspace({
  variant,
  initialBookId,
  initialEntryId,
  onClose,
  onOpenFullEditor,
  onImportRequest,
  fullscreen = false,
  onToggleFullscreen,
}: LorebookEditorWorkspaceProps) {
  const { settings, updateSettings } = useLorebookEditorLayoutSettings()
  const [books, setBooks] = useState<WorldBook[]>([])
  const [entries, setEntries] = useState<WorldBookEntry[]>([])
  const entriesRef = useRef<WorldBookEntry[]>([])
  const [bookSearch, setBookSearch] = useState('')
  const [entrySearch, setEntrySearch] = useState('')
  const [selectedBookId, setSelectedBookId] = useState<string | null>(initialBookId ?? null)
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(initialEntryId ?? null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [entriesComplete, setEntriesComplete] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [conflicts, setConflicts] = useState<Record<string, EntryConflictState>>({})
  // Every bulk control starts in the same "leave as is" state `enabled` already
  // had. A literal here (the old '10' / '4' / '0' / 'keyword') is impossible to
  // tell apart from a deliberate choice, which is how a State-only Apply used to
  // overwrite priority, depth and position on every selected entry and demote
  // every semantic entry to a keyword entry. See `lib/lorebookBulkPatch.ts`.
  const [bulkPriority, setBulkPriority] = useState(EMPTY_BULK_FIELD_FORM.priority)
  const [bulkDepth, setBulkDepth] = useState(EMPTY_BULK_FIELD_FORM.depth)
  const [bulkPosition, setBulkPosition] = useState<BulkPositionSelection>(EMPTY_BULK_FIELD_FORM.position)
  const [bulkTrigger, setBulkTrigger] = useState<BulkTriggerSelection>(EMPTY_BULK_FIELD_FORM.trigger)
  const [bulkEnabled, setBulkEnabled] = useState<BulkEnabledSelection>(EMPTY_BULK_FIELD_FORM.enabled)
  const [bulkVisible, setBulkVisible] = useState(false)
  const [typeFilter, setTypeFilter] = useState<'all' | TriggerType>('all')
  const entrySearchInputRef = useRef<HTMLInputElement | null>(null)
  const pendingDrafts = useRef<Record<string, Partial<WorldBookEntry>>>({})
  const saveQueues = useRef<Record<string, Promise<void>>>({})
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const splitterDrag = useRef<{ pane: 'books' | 'entries'; startX: number; startWidth: number } | null>(null)
  const panesRef = useRef<HTMLDivElement | null>(null)
  // `initialEntryId` is an *opening* instruction, not a standing preference. The
  // store never clears it (`store/slices/world-info.ts` keeps `entryId` after
  // close) and the Lore Indicator seeds it with a real id, so honouring it on
  // every load made Refresh — and every bulk action, which ends in `loadEntries`
  // — snap the selection back to whatever the editor was opened with, discarding
  // the row the user had actually clicked. Consume it exactly once.
  const pendingInitialEntryId = useRef<string | null>(initialEntryId ?? null)

  useEffect(() => {
    const next = initialEntryId ?? null
    pendingInitialEntryId.current = next
    if (!next) return
    // Re-opening onto a different entry while the book is already loaded fires no
    // load at all, so apply it here and consume the pin immediately — otherwise it
    // would sit armed and hijack the next unrelated Refresh.
    if (entriesRef.current.some((entry) => entry.id === next)) {
      pendingInitialEntryId.current = null
      setSelectedEntryId(next)
    }
  }, [initialEntryId])

  const commitEntries = useCallback((
    update: WorldBookEntry[] | ((current: WorldBookEntry[]) => WorldBookEntry[]),
  ) => {
    const next = typeof update === 'function' ? update(entriesRef.current) : update
    entriesRef.current = next
    setEntries(next)
  }, [])


  // The book whose entries have most recently been *requested*, plus a monotonic
  // sequence for the requests themselves.
  //
  // Two independent paths ask for the opening book's entries: the mount effect
  // below, which can start immediately because `selectedBookId` is seeded from
  // `initialBookId`, and `loadBooks`, which starts it the instant the book list
  // names a book. The id latch is what keeps that one round trip instead of two;
  // the sequence is what stops a slow answer from overwriting a newer one.
  const selectedBookIdRef = useRef<string | null>(selectedBookId)
  selectedBookIdRef.current = selectedBookId
  const requestedEntriesBookId = useRef<string | null>(null)
  const entriesRequestSeq = useRef(0)

  useEffect(() => {
    setSavedAt(null)
    setEntrySearch('')
    setTypeFilter('all')
  }, [selectedBookId])

  const loadEntries = useCallback((bookId: string, preserveSelection = true): Promise<void> => {
    requestedEntriesBookId.current = bookId
    const seq = ++entriesRequestSeq.current
    setLoading(true)
    setEntriesComplete(false)
    return (async () => {
      try {
        const result = await worldBooksApi.listAllEntries(bookId)
        // A newer request started while this one was in flight — a book switch,
        // Refresh, or the reload that ends every bulk action. That answer is the
        // current one, so this older payload is dropped rather than committed
        // over the top of it.
        if (seq !== entriesRequestSeq.current) return
        commitEntries(result)
        setEntriesComplete(true)
        setSelectedEntryId((current) => {
          const pending = pendingInitialEntryId.current
          if (pending && result.some((entry) => entry.id === pending)) {
            pendingInitialEntryId.current = null
            return pending
          }
          if (preserveSelection && current && result.some((entry) => entry.id === current)) return current
          return result[0]?.id ?? null
        })
        setSelectedIds((current) => current.filter((id) => result.some((entry) => entry.id === id)))
      } finally {
        // Only the newest request owns the spinner; a superseded one clearing it
        // would report "loaded" while the current fetch is still out.
        if (seq === entriesRequestSeq.current) setLoading(false)
      }
    })()
    // The opening entry id is carried by a ref, not a dep: keeping it here also
    // churned `loadEntries`' identity and re-fired the mount effects below.
  }, [commitEntries])

  const loadBooks = useCallback(async () => {
    const result = await worldBooksApi.list({ limit: 1000 })
    setBooks(result.data)
    // The same precedence as the state update on the next line, resolved from a
    // ref so the entries request can be issued in this tick. Waiting for
    // `setSelectedBookId` to commit and the selection effect to fire costs an
    // entire render of the books pane before the request the user is actually
    // waiting on is even sent — that is the whole of the open waterfall on the
    // path where no book was passed in.
    //
    // Reading the ref rather than the updater's `current` is what makes it a
    // read: at worst it is one commit stale, which can only mean picking the book
    // the selection effect is about to ask for anyway — and the latch below makes
    // the loser of that race a no-op rather than a second fetch.
    const resolved = selectedBookIdRef.current ?? initialBookId ?? result.data[0]?.id ?? null
    setSelectedBookId((current) => current ?? initialBookId ?? result.data[0]?.id ?? null)
    if (resolved && requestedEntriesBookId.current !== resolved) void loadEntries(resolved, false)
  }, [initialBookId, loadEntries])

  // The two opening requests, issued in the same tick.
  //
  // `selectedBookId` is seeded from `initialBookId`, and every call site that
  // opens this editor passes a book, so the entries request — the one that
  // decides when the first row appears — must not queue behind a 209-row book
  // list. Issuing it here, ahead of `loadBooks`, makes that a stated guarantee
  // rather than an accident of effect-declaration order. With no book known yet
  // there is nothing to request, and `loadBooks` covers that case itself.
  useEffect(() => {
    const openingBookId = selectedBookIdRef.current
    if (openingBookId && requestedEntriesBookId.current !== openingBookId) {
      void loadEntries(openingBookId, false)
    }
    void loadBooks()
  }, [loadBooks, loadEntries])

  useEffect(() => {
    if (!selectedBookId) {
      // Never blank a list a parallel load has already filled: `loadBooks` can
      // resolve the book and start its entries fetch a commit before its
      // `setSelectedBookId` lands here.
      if (requestedEntriesBookId.current !== null) return
      commitEntries([])
      return
    }
    // Already asked for, by the mount effect or by `loadBooks`. Re-issuing it
    // here is exactly the double fetch the latch exists to prevent.
    if (requestedEntriesBookId.current === selectedBookId) return
    void loadEntries(selectedBookId, false)
  }, [commitEntries, loadEntries, selectedBookId])

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const drag = splitterDrag.current
      if (!drag) return
      const delta = event.clientX - drag.startX
      if (drag.pane === 'books') {
        const panesWidth = panesRef.current?.getBoundingClientRect().width ?? window.innerWidth
        const maxBooksWidth = Math.max(180, panesWidth - settings.entriesPaneWidth - 340)
        updateSettings({ booksPaneWidth: Math.max(180, Math.min(maxBooksWidth, drag.startWidth + delta)) })
      } else {
        const panesWidth = panesRef.current?.getBoundingClientRect().width ?? window.innerWidth
        const reservedWidth = variant === 'full' ? settings.booksPaneWidth + 14 : 7
        const maxEntriesWidth = Math.max(280, panesWidth - reservedWidth - 280)
        const width = Math.max(280, Math.min(maxEntriesWidth, drag.startWidth + delta))
        updateSettings(variant === 'half' ? { halfEntriesPaneWidth: width } : { entriesPaneWidth: width })
      }
    }
    const handleUp = () => {
      splitterDrag.current = null
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [settings.booksPaneWidth, settings.entriesPaneWidth, updateSettings, variant])

  // Name + folder, via the shared module the half editor's picker also agrees
  // with. This widens the Books pane search from name-only — intended, so the
  // two surfaces cannot answer the same query differently.
  const filteredBooks = useMemo(() => filterBooks(books, bookSearch), [bookSearch, books])

  /**
   * One index for the life of the workspace. It memoises normalized authored
   * fields and source offsets per entry object, checking its authored values for
   * edits. It must not be rebuilt when the query changes — rebuilding it per
   * keystroke would restore the very cost it exists to remove.
   */
  const entrySearchIndex = useMemo(() => createEntrySearchIndex(), [])

  const entrySearchResults = useMemo(
    () => searchEntriesByQuery(entries, entrySearch, entrySearchIndex),
    [entries, entrySearch, entrySearchIndex],
  )
  const searchActive = entrySearchResults !== null
  const queryEntries = useMemo(
    () => entrySearchResults?.map((result) => result.entry) ?? entries,
    [entries, entrySearchResults],
  )
  const entrySearchResultsById = useMemo(
    () => new Map(entrySearchResults?.map((result) => [result.entry.id, result]) ?? []),
    [entrySearchResults],
  )
  const filteredEntries = useMemo(
    () => typeFilter === 'all'
      ? queryEntries
      : queryEntries.filter((entry) => getTriggerType(entry) === typeFilter),
    [queryEntries, typeFilter],
  )

  // `listAllEntries` always requests `sort_by: 'order'`, which is this editor's
  // custom-order view. There is no alternate sort control in this workspace.
  const reorderEnabled = !loading
    && !reordering
    && entriesComplete
    && entrySearch.trim() === ''
    && typeFilter === 'all'

  // Background token counting. Everything it produces is client-only: it reaches
  // the Tokens column through a module-level cache and `useSyncExternalStore`,
  // never through the entry object, so no prefetch can trigger a save, bump
  // `revision`, flash "Saved", or remount the inspector mid-edit.
  const {
    resolveTokenCount,
    handleEntryPointerEnter,
    handleEntryPointerLeave,
  } = useLorebookTokenCounts(filteredEntries, true)

  const typeCounts = useMemo(() => ({
    constant: queryEntries.filter((entry) => getTriggerType(entry) === 'constant').length,
    keyword: queryEntries.filter((entry) => getTriggerType(entry) === 'keyword').length,
    vector: queryEntries.filter((entry) => getTriggerType(entry) === 'vector').length,
  }), [queryEntries])

  const handleWorkspaceKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.altKey || event.shiftKey) return
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
    event.preventDefault()
    event.stopPropagation()
    entrySearchInputRef.current?.focus()
    entrySearchInputRef.current?.select()
  }, [])

  const selectedEntry = entries.find((entry) => entry.id === selectedEntryId) ?? null
  const selectedBook = books.find((book) => book.id === selectedBookId) ?? null
  const showTokens = settings.visibleEntryMetadata.includes('tokens')

  const visibleColumns = useMemo(
    () => resolveVisibleColumns(settings.visibleEntryMetadata),
    [settings.visibleEntryMetadata],
  )
  const entryGridTemplate = useMemo(() => buildEntryGridTemplate(visibleColumns), [visibleColumns])
  const entryTableMinWidth = useMemo(() => buildEntryTableMinWidth(visibleColumns), [visibleColumns])

  // Stored arrays are replaced wholesale rather than merged, so a column added to
  // the defaults would stay invisible on every install that already persisted this
  // setting. Backfill once, recording the version so a later untick sticks.
  useEffect(() => {
    const storedVersion = settings.entryMetadataVersion ?? 0
    if (storedVersion >= ENTRY_METADATA_VERSION) return
    updateSettings({
      visibleEntryMetadata: backfillEntryMetadata(settings.visibleEntryMetadata, storedVersion),
      entryMetadataVersion: ENTRY_METADATA_VERSION,
    })
  }, [settings.entryMetadataVersion, settings.visibleEntryMetadata, updateSettings])

  const allFilteredSelected = filteredEntries.length > 0
    && filteredEntries.every((entry) => selectedIds.includes(entry.id))

  // Reveal the bulk bar when a selection appears and collapse it when the
  // selection is cleared, while still letting the toolbar button override in
  // between. Deriving visibility from the selection instead made the button a
  // no-op whenever anything was selected.
  const hasSelection = selectedIds.length > 0
  useEffect(() => {
    setBulkVisible(hasSelection)
  }, [hasSelection])

  const toggleTokenColumn = useCallback(() => {
    const visibleEntryMetadata = showTokens
      ? settings.visibleEntryMetadata.filter((item) => item !== 'tokens')
      : [...settings.visibleEntryMetadata, 'tokens']
    updateSettings({ visibleEntryMetadata })
  }, [settings.visibleEntryMetadata, showTokens, updateSettings])

  const applyConflict = useCallback((
    payload: WorldBookEntryConflictPayload,
    drafts: Record<string, Partial<WorldBookEntry>>,
  ) => {
    commitEntries((current) => {
      const currentMap = new Map(payload.conflicts.map((conflict) => [conflict.id, conflict.current]))
      return current.map((entry) => currentMap.get(entry.id) ?? entry).filter(Boolean) as WorldBookEntry[]
    })
    setConflicts((current) => {
      const next = { ...current }
      for (const conflict of payload.conflicts) {
        if (!conflict.current) continue
        next[conflict.id] = {
          server: conflict.current,
          draft: drafts[conflict.id] ?? pendingDrafts.current[conflict.id] ?? {},
        }
      }
      return next
    })
  }, [commitEntries])

  const reorderEntries = useCallback(async (activeId: string, overId: string) => {
    if (!selectedBookId || !reorderEnabled || activeId === overId) return
    const reorderBookId = selectedBookId
    const currentEntries = entriesRef.current
    const oldIndex = currentEntries.findIndex((entry) => entry.id === activeId)
    const newIndex = currentEntries.findIndex((entry) => entry.id === overId)
    if (oldIndex < 0 || newIndex < 0) return

    const orderedEntries = arrayMove(currentEntries, oldIndex, newIndex)
    const orderedIds = orderedEntries.map((entry) => entry.id)
    const expectedRevisions = expectedRevisionMap(currentEntries, orderedIds)
    setReordering(true)
    commitEntries(orderedEntries)
    try {
      await runLorebookReorderIfCurrent({
        bookId: reorderBookId,
        getCurrentBookId: () => selectedBookIdRef.current,
        reorder: () => worldBooksApi.reorderEntries(reorderBookId, {
          ordered_ids: orderedIds,
          expected_revisions: expectedRevisions,
        }).then(() => undefined),
        refresh: () => loadEntries(reorderBookId),
        onSaved: () => setSavedAt(Date.now()),
      })
    } catch (error) {
      if (selectedBookIdRef.current !== reorderBookId) return
      const payload = conflictPayload(error)
      if (payload) applyConflict(payload, {})
      await loadEntries(reorderBookId)
    } finally {
      setReordering(false)
    }
  }, [applyConflict, commitEntries, loadEntries, reorderEnabled, selectedBookId])

  const saveEntry = useCallback((entryId: string, updates: Partial<WorldBookEntry>) => {
    pendingDrafts.current[entryId] = { ...pendingDrafts.current[entryId], ...updates }
    commitEntries((current) => current.map((entry) => (
      entry.id === entryId ? { ...entry, ...updates } : entry
    )))

    const previous = saveQueues.current[entryId] ?? Promise.resolve()
    const next = previous.then(async () => {
      if (!selectedBookId) return
      const draft = pendingDrafts.current[entryId]
      if (!draft || Object.keys(draft).length === 0) return
      delete pendingDrafts.current[entryId]
      const current = entriesRef.current.find((entry) => entry.id === entryId)
      if (!current) return
      try {
        const updated = await worldBooksApi.updateEntry(selectedBookId, entryId, {
          ...draft,
          expected_revision: current.revision,
        })
        commitEntries((items) => items.map((entry) => entry.id === entryId ? updated : entry))
        setConflicts((state) => {
          if (!state[entryId]) return state
          const nextState = { ...state }
          delete nextState[entryId]
          return nextState
        })
        setSavedAt(Date.now())
      } catch (error) {
        const payload = conflictPayload(error)
        if (payload) {
          applyConflict(payload, { [entryId]: draft })
          return
        }
        pendingDrafts.current[entryId] = { ...draft, ...pendingDrafts.current[entryId] }
        throw error
      }
    })
    saveQueues.current[entryId] = next.catch(() => {})
    return next
  }, [applyConflict, commitEntries, selectedBookId])

  const debouncedSaveEntry = useCallback((entryId: string, updates: Partial<WorldBookEntry>) => {
    pendingDrafts.current[entryId] = { ...pendingDrafts.current[entryId], ...updates }
    commitEntries((current) => current.map((entry) => (
      entry.id === entryId ? { ...entry, ...updates } : entry
    )))
    clearTimeout(debounceTimers.current[entryId])
    debounceTimers.current[entryId] = setTimeout(() => {
      const draft = pendingDrafts.current[entryId] ?? {}
      void saveEntry(entryId, draft)
    }, 450)
  }, [commitEntries, saveEntry])

  const resolveConflict = useCallback(async (entryId: string, reapply: boolean) => {
    const conflict = conflicts[entryId]
    if (!conflict || !selectedBookId) return
    if (!reapply) {
      setConflicts((current) => {
        const next = { ...current }
        delete next[entryId]
        return next
      })
      return
    }
    pendingDrafts.current[entryId] = { ...conflict.draft }
    commitEntries((current) => current.map((entry) => (
      entry.id === entryId ? { ...conflict.server, ...conflict.draft } : entry
    )))
    await saveEntry(entryId, conflict.draft)
  }, [commitEntries, conflicts, saveEntry, selectedBookId])

  const runBulk = useCallback(async (input: BulkMutationInput) => {
    if (!selectedBookId) return
    const ids = input.entry_ids
    const drafts = Object.fromEntries(ids.map((id) => [id, pendingDrafts.current[id] ?? {}]))
    try {
      await worldBooksApi.bulkEntryAction(selectedBookId, {
        ...input,
        expected_revisions: expectedRevisionMap(entriesRef.current, ids),
      } as WorldBookEntryBulkActionInput)
      await loadEntries(selectedBookId)
      setSavedAt(Date.now())
    } catch (error) {
      const payload = conflictPayload(error)
      if (payload) {
        applyConflict(payload, drafts)
        return
      }
      throw error
    }
  }, [applyConflict, loadEntries, selectedBookId])

  const bulkForm = useMemo<BulkFieldForm>(() => ({
    priority: bulkPriority,
    depth: bulkDepth,
    position: bulkPosition,
    trigger: bulkTrigger,
    enabled: bulkEnabled,
  }), [bulkDepth, bulkEnabled, bulkPosition, bulkPriority, bulkTrigger])

  const bulkHasMutation = useMemo(() => hasBulkFieldMutation(bulkForm), [bulkForm])

  const applyBulk = useCallback(async () => {
    if (selectedIds.length === 0) return
    // Sparse by construction: a key the user never set is never sent, and the
    // server only writes columns it receives.
    const patch = buildBulkFieldPatch(bulkForm)
    // Nothing touched. The server answers an empty set_fields with a 400, so this
    // must not reach the wire.
    if (Object.keys(patch).length === 0) return
    await runBulk({ action: 'set_fields', entry_ids: selectedIds, fields: patch })
  }, [bulkForm, runBulk, selectedIds])

  const createBook = useCallback(async () => {
    const book = await worldBooksApi.create({ name: 'New Lorebook' })
    setBooks((current) => [book, ...current])
    setSelectedBookId(book.id)
  }, [])

  const createEntry = useCallback(async () => {
    if (!selectedBookId) return
    const entry = await worldBooksApi.createEntry(selectedBookId, {
      comment: 'New Entry',
      key: [],
      content: '',
    })
    commitEntries((current) => [entry, ...current])
    setSelectedEntryId(entry.id)
  }, [commitEntries, selectedBookId])

  const duplicateSelected = useCallback(async () => {
    if (!selectedBookId || selectedIds.length === 0) return
    await runBulk({ action: 'copy', entry_ids: selectedIds, target_book_id: selectedBookId })
  }, [runBulk, selectedBookId, selectedIds])

  const deleteSelected = useCallback(async () => {
    if (selectedIds.length === 0) return
    await runBulk({ action: 'delete', entry_ids: selectedIds })
    setSelectedIds([])
  }, [runBulk, selectedIds])

  const toggleEntrySelection = (entryId: string) => {
    setSelectedIds((current) => current.includes(entryId)
      ? current.filter((id) => id !== entryId)
      : [...current, entryId])
  }

  const toggleSelectAll = () => {
    const filteredIds = filteredEntries.map((entry) => entry.id)
    setSelectedIds((current) => allFilteredSelected
      ? current.filter((id) => !filteredIds.includes(id))
      : [...new Set([...current, ...filteredIds])])
  }

  return (
    <section
      className={clsx(styles.workspace, variant === 'half' && styles.halfWorkspace)}
      onKeyDownCapture={handleWorkspaceKeyDown}
      style={{
        '--lorebook-books-width': `${settings.booksPaneWidth}px`,
        '--lorebook-entries-width': `${variant === 'half' ? settings.halfEntriesPaneWidth : settings.entriesPaneWidth}px`,
        '--lorebook-inspector-width': `${settings.inspectorPaneWidth}px`,
      } as React.CSSProperties}
      data-density={settings.rowDensity}
      data-component="LorebookEditorWorkspace"
    >
      <header className={styles.workspaceHeader}>
        <div className={styles.headerIdentity}>
          <BookOpen size={18} />
          <div>
            <strong>World Book Editor</strong>
            <span>{selectedBook?.name ?? 'Select a lorebook'}</span>
          </div>
        </div>
        <div className={styles.headerActions}>
          <label className={styles.displayToggle}>
            <span>Trigger display</span>
            <select
              value={settings.triggerDisplay}
              onChange={(event) => updateSettings({ triggerDisplay: event.target.value as 'words' | 'icons' })}
            >
              <option value="words">Words</option>
              <option value="icons">Icons</option>
            </select>
          </label>
          {onImportRequest && (
            <button type="button" onClick={onImportRequest} title="Import a lorebook" aria-label="Import a lorebook">
              <Upload size={14} />
              {variant === 'full' && 'Import'}
            </button>
          )}
          {variant === 'half' && (
            <button
              type="button"
              onClick={() => onOpenFullEditor?.(selectedBookId, selectedEntryId)}
              title="Full-Screen Lorebook Editor"
              aria-label="Full-Screen Lorebook Editor"
            >
              <ExternalLink size={14} />
            </button>
          )}
          {onToggleFullscreen && (
            <button
              type="button"
              onClick={onToggleFullscreen}
              title={fullscreen ? 'Restore editor' : 'Fullscreen editor'}
              aria-label={fullscreen ? 'Restore editor' : 'Fullscreen editor'}
            >
              {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => void createEntry()}
            disabled={!selectedBookId}
            title="New entry"
          >
            <Plus size={14} />
            {variant === 'full' && 'New Entry'}
          </button>
          {onClose && (
            <button type="button" onClick={onClose} title="Close editor" aria-label="Close editor">
              <X size={14} />
              {variant === 'full' && 'Close'}
            </button>
          )}
        </div>
      </header>
      <span data-spindle-mount="lorebook_workspace" data-spindle-scope={`lorebook:${selectedBookId ?? 'none'}:workspace`} style={{ display: 'contents' }} />

      <div className={styles.panes} ref={panesRef}>
        {variant === 'full' && (
          <>
            <aside className={styles.booksPane}>
              <div className={styles.paneTitle}><span>Books</span><span>{books.length}</span></div>
              <label className={styles.searchField}>
                <Search size={14} />
                <input value={bookSearch} onChange={(event) => setBookSearch(event.target.value)} placeholder="Search books..." />
              </label>
              <div className={styles.scrollList}>
                {filteredBooks.map((book) => (
                  <button
                    type="button"
                    key={book.id}
                    className={clsx(styles.bookRow, book.id === selectedBookId && styles.activeRow)}
                    onClick={() => setSelectedBookId(book.id)}
                  >
                    <BookOpen size={14} />
                    <span>{book.name}</span>
                  </button>
                ))}
              </div>
              <button type="button" className={styles.bottomAction} onClick={() => void createBook()}>
                <Plus size={14} /> New Book
              </button>
            </aside>
            <div
              className={styles.splitter}
              onPointerDown={(event) => {
                splitterDrag.current = { pane: 'books', startX: event.clientX, startWidth: settings.booksPaneWidth }
              }}
            />
          </>
        )}

        <div className={styles.entriesPane}>
          <div className={styles.paneTitle}>
            <input
              type="checkbox"
              className={styles.selectAllBox}
              checked={allFilteredSelected}
              onChange={toggleSelectAll}
              disabled={filteredEntries.length === 0}
              aria-label="Select all listed entries"
              title="Select all listed entries"
            />
            <span className={styles.paneTitleLabel}>Entries</span>
            {selectedIds.length > 0 && <span className={styles.paneTitleCount}>{selectedIds.length} selected</span>}
            <div className={styles.paneTitleActions}>
              <span>{filteredEntries.length === entries.length ? entries.length : `${filteredEntries.length}/${entries.length}`}</span>
              <button
                type="button"
                onClick={toggleTokenColumn}
                title={showTokens ? 'Hide token column' : 'Show token column'}
                aria-label={showTokens ? 'Hide token column' : 'Show token column'}
              >
                {showTokens ? <Eye size={13} /> : <EyeOff size={13} />}
                Tokens
              </button>
            </div>
          </div>

          <EntriesToolbar
            variant={variant}
            books={books}
            selectedBookId={selectedBookId}
            setSelectedBookId={setSelectedBookId}
            onCreateBook={() => void createBook()}
            entrySearch={entrySearch}
            setEntrySearch={setEntrySearch}
            entrySearchInputRef={entrySearchInputRef}
            searchActive={searchActive}
            matchCount={filteredEntries.length}
            totalEntryCount={entries.length}
            bulkVisible={bulkVisible}
            setBulkVisible={setBulkVisible}
            entryCount={queryEntries.length}
            typeCounts={typeCounts}
            typeFilter={typeFilter}
            setTypeFilter={setTypeFilter}
            selectedIds={selectedIds}
            bulkPriority={bulkPriority}
            setBulkPriority={setBulkPriority}
            bulkPosition={bulkPosition}
            setBulkPosition={setBulkPosition}
            bulkDepth={bulkDepth}
            setBulkDepth={setBulkDepth}
            bulkTrigger={bulkTrigger}
            setBulkTrigger={setBulkTrigger}
            bulkEnabled={bulkEnabled}
            setBulkEnabled={setBulkEnabled}
            bulkHasMutation={bulkHasMutation}
            applyBulk={applyBulk}
          />

          <EntryTable
            bookId={selectedBookId}
            entries={entries}
            filteredEntries={filteredEntries}
            searchResultsById={entrySearchResultsById}
            searchActive={searchActive}
            searchQuery={entrySearch}
            typeFilter={typeFilter}
            onClearSearch={() => setEntrySearch('')}
            onClearTypeFilter={() => setTypeFilter('all')}
            loading={loading}
            reorderEnabled={reorderEnabled}
            onReorder={reorderEntries}
            visibleColumns={visibleColumns}
            entryGridTemplate={entryGridTemplate}
            entryTableMinWidth={entryTableMinWidth}
            selectedEntryId={selectedEntryId}
            setSelectedEntryId={setSelectedEntryId}
            selectedIds={selectedIds}
            toggleEntrySelection={toggleEntrySelection}
            triggerDisplay={settings.triggerDisplay}
            saveEntry={saveEntry}
            onEntryPointerEnter={handleEntryPointerEnter}
            onEntryPointerLeave={handleEntryPointerLeave}
            resolveTokenCount={resolveTokenCount}
          />
          <div className={styles.listActions}>
            <button type="button" onClick={() => void duplicateSelected()} disabled={selectedIds.length === 0}><Copy size={13} /> Duplicate</button>
            <button type="button" onClick={() => void deleteSelected()} disabled={selectedIds.length === 0}><Trash2 size={13} /> Delete</button>
            <button type="button" onClick={() => selectedBookId && void loadEntries(selectedBookId)}><RefreshCw size={13} /> Refresh</button>
          </div>
        </div>

        <div
          className={styles.splitter}
          onPointerDown={(event) => {
            splitterDrag.current = {
              pane: 'entries',
              startX: event.clientX,
              startWidth: variant === 'half' ? settings.halfEntriesPaneWidth : settings.entriesPaneWidth,
            }
          }}
        />

        <aside className={styles.inspectorPane}>
          <div className={styles.paneTitle}>
            <span>Editing Entry</span>
            <span>{savedAt ? 'Saved' : ''}</span>
          </div>
          {selectedEntry ? (
            <>
              {conflicts[selectedEntry.id] && (
                <div className={styles.conflictBanner} role="alert">
                  <strong>Newer server revision detected.</strong>
                  <span>Your unsaved draft is preserved.</span>
                  <button type="button" onClick={() => void resolveConflict(selectedEntry.id, true)}>Reapply draft</button>
                  <button type="button" onClick={() => void resolveConflict(selectedEntry.id, false)}>Use server version</button>
                </div>
              )}
              {/* Keyed on id + conflict state only. Including the revision remounted
                  the editor on every background save — including the automatic token
                  estimate — which reset local field state mid-edit. */}
              <WorldBookEntryEditor
                key={`${selectedEntry.id}:${conflicts[selectedEntry.id] ? 'conflict' : 'clean'}`}
                entry={selectedEntry}
                onUpdate={debouncedSaveEntry}
                onImmediateUpdate={saveEntry}
                density="compact"
              />
            </>
          ) : (
            <div className={styles.empty}>Select an entry to edit.</div>
          )}
        </aside>
      </div>
    </section>
  )
}
