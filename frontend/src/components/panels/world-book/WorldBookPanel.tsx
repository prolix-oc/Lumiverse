import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2, BookOpen, Maximize2, ChevronDown, Upload, Globe, X, User, FileUp, Settings, Search } from 'lucide-react'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import { worldBooksApi } from '@/api/world-books'
import WorldBookEntryEditor from '@/components/shared/WorldBookEntryEditor'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import ImportWorldBookModal, { type WorldBookImportResult } from '@/components/modals/ImportWorldBookModal'
import PostImportWorldBookModal from '@/components/shared/PostImportWorldBookModal'
import WorldBookDiagnosticsModal from '@/components/panels/world-book/WorldBookDiagnosticsModal'
import { formatWorldBookReindexStatus } from '@/lib/worldBookVectorization'
import type { WorldBook, WorldBookEntry, WorldBookVectorSummary, WorldInfoSettings } from '@/types/api'
import styles from './WorldBookPanel.module.css'
import clsx from 'clsx'

export default function WorldBookPanel() {
  const openModal = useStore((s) => s.openModal)
  const isMobile = useIsMobile()
  const activeChatId = useStore((s) => s.activeChatId)
  const globalWorldBooks = useStore((s) => s.globalWorldBooks)
  const worldInfoSettings = useStore((s) => s.worldInfoSettings)
  const setSetting = useStore((s) => s.setSetting)
  const [wiSettingsOpen, setWiSettingsOpen] = useState(false)

  // Book list state
  const [books, setBooks] = useState<WorldBook[]>([])
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null)

  // Entry state
  const [entries, setEntries] = useState<WorldBookEntry[]>([])
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [entryTotal, setEntryTotal] = useState(0)
  const [entryOffset, setEntryOffset] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)

  // Book editing state
  const [bookFieldsOpen, setBookFieldsOpen] = useState(false)
  const [bookName, setBookName] = useState('')
  const [bookDescription, setBookDescription] = useState('')
  const [vectorStatus, setVectorStatus] = useState<string | null>(null)
  const [vectorSummary, setVectorSummary] = useState<WorldBookVectorSummary | null>(null)
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false)
  const [semanticUpdating, setSemanticUpdating] = useState(false)
  const [postImportBook, setPostImportBook] = useState<WorldBook | null>(null)

  // Confirmation modals
  const [deleteBookConfirm, setDeleteBookConfirm] = useState<string | null>(null)
  const [deleteEntryConfirm, setDeleteEntryConfirm] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)

  // Debounce refs
  const bookNameTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const bookDescTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const entryTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const bulkSemanticToggleRef = useRef<HTMLInputElement>(null)

  const nonEmptyEntryCount = vectorSummary?.non_empty ?? 0
  const enabledNonEmptyCount = vectorSummary?.enabled_non_empty ?? 0
  const allNonEmptySemanticEnabled = nonEmptyEntryCount > 0 && enabledNonEmptyCount === nonEmptyEntryCount
  const someNonEmptySemanticEnabled = enabledNonEmptyCount > 0 && enabledNonEmptyCount < nonEmptyEntryCount

  useEffect(() => {
    if (!bulkSemanticToggleRef.current) return
    bulkSemanticToggleRef.current.indeterminate = someNonEmptySemanticEnabled
  }, [someNonEmptySemanticEnabled])

  // Load books
  const loadBooks = useCallback(async () => {
    try {
      const res = await worldBooksApi.list({ limit: 200 })
      setBooks(res.data)
    } catch {}
  }, [])

  useEffect(() => {
    loadBooks()
  }, [loadBooks])

  const ENTRIES_PAGE_SIZE = 50

  // Load entries when book selected
  const loadEntries = useCallback(async (bookId: string) => {
    try {
      const res = await worldBooksApi.listEntries(bookId, { limit: ENTRIES_PAGE_SIZE, offset: 0 })
      setEntries(res.data)
      setEntryTotal(res.total)
      setEntryOffset(res.data.length)
    } catch {}
  }, [])

  const loadVectorSummary = useCallback(async (bookId: string) => {
    try {
      const summary = await worldBooksApi.getVectorSummary(bookId)
      setVectorSummary(summary)
    } catch {
      setVectorSummary(null)
    }
  }, [])

  const loadMoreEntries = useCallback(async () => {
    if (!selectedBookId || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await worldBooksApi.listEntries(selectedBookId, { limit: ENTRIES_PAGE_SIZE, offset: entryOffset })
      setEntries((prev) => [...prev, ...res.data])
      setEntryTotal(res.total)
      setEntryOffset((prev) => prev + res.data.length)
    } catch {}
    setLoadingMore(false)
  }, [selectedBookId, entryOffset, loadingMore])

  useEffect(() => {
    if (selectedBookId) {
      loadEntries(selectedBookId)
      loadVectorSummary(selectedBookId)
      const book = books.find((b) => b.id === selectedBookId)
      if (book) {
        setBookName(book.name)
        setBookDescription(book.description)
      }
      setSelectedEntryId(null)
      setShowDiagnosticsModal(false)
    } else {
      setEntries([])
      setEntryTotal(0)
      setEntryOffset(0)
      setSelectedEntryId(null)
      setVectorSummary(null)
      setShowDiagnosticsModal(false)
    }
  }, [selectedBookId, books, loadEntries, loadVectorSummary])

  // Book CRUD
  const handleCreateBook = useCallback(async () => {
    try {
      const book = await worldBooksApi.create({ name: 'New World Book' })
      setBooks((prev) => [book, ...prev])
      setSelectedBookId(book.id)
    } catch {}
  }, [])

  const handleDeleteBook = useCallback(
    async (id: string) => {
      try {
        await worldBooksApi.delete(id)
        setBooks((prev) => prev.filter((b) => b.id !== id))
        if (selectedBookId === id) {
          setSelectedBookId(null)
        }
      } catch {}
    },
    [selectedBookId]
  )

  const handleBookNameChange = useCallback(
    (value: string) => {
      setBookName(value)
      clearTimeout(bookNameTimer.current)
      bookNameTimer.current = setTimeout(() => {
        if (selectedBookId && value.trim()) {
          worldBooksApi.update(selectedBookId, { name: value.trim() })
          setBooks((prev) =>
            prev.map((b) => (b.id === selectedBookId ? { ...b, name: value.trim() } : b))
          )
        }
      }, 2000)
    },
    [selectedBookId]
  )

  const handleBookDescChange = useCallback(
    (value: string) => {
      setBookDescription(value)
      clearTimeout(bookDescTimer.current)
      bookDescTimer.current = setTimeout(() => {
        if (selectedBookId) {
          worldBooksApi.update(selectedBookId, { description: value })
        }
      }, 2000)
    },
    [selectedBookId]
  )

  // Entry CRUD
  const handleCreateEntry = useCallback(async () => {
    if (!selectedBookId) return
    try {
      const entry = await worldBooksApi.createEntry(selectedBookId, {
        comment: 'New Entry',
        key: [],
        content: '',
      })
      setEntries((prev) => [...prev, entry])
      setEntryTotal((prev) => prev + 1)
      setEntryOffset((prev) => prev + 1)
      setSelectedEntryId(entry.id)
    } catch {}
  }, [selectedBookId])

  const [reindexing, setReindexing] = useState(false)

  const handleReindexVectors = useCallback(async () => {
    if (!selectedBookId || reindexing) return
    try {
      setReindexing(true)
      setVectorStatus('Reindexing vectors...')
      const result = await worldBooksApi.reindexVectors(selectedBookId, {
        onProgress: (p) => {
          setVectorStatus(`Reindexing... ${formatWorldBookReindexStatus(p)}`)
        },
      })
      const finalStatus = formatWorldBookReindexStatus(result)
      setVectorStatus(`Done: ${finalStatus}`)
      await loadEntries(selectedBookId)
      await loadVectorSummary(selectedBookId)
    } catch {
      setVectorStatus('Failed to reindex vectors')
    } finally {
      setReindexing(false)
    }
  }, [selectedBookId, reindexing, loadEntries, loadVectorSummary])

  const handleBulkSemanticActivation = useCallback(async (enabled: boolean) => {
    if (!selectedBookId) return
    try {
      setSemanticUpdating(true)
      const result = await worldBooksApi.setSemanticActivation(selectedBookId, enabled)
      setVectorSummary(result.summary)
      await loadEntries(selectedBookId)
      setVectorStatus(
        enabled
          ? result.summary.non_empty > 0
            ? `Semantic activation is on for ${result.summary.enabled_non_empty}/${result.summary.non_empty} non-empty entries. Reindex semantic search to refresh vectors.`
            : 'This book does not have any non-empty entries to enable for semantic activation.'
          : 'Semantic activation is off for all entries in this book.'
      )
    } catch {
      setVectorStatus(enabled ? 'Failed to enable semantic activation' : 'Failed to disable semantic activation')
    } finally {
      setSemanticUpdating(false)
    }
  }, [selectedBookId, loadEntries])

  const handleDiagnostics = useCallback(async () => {
    if (!selectedBookId || !activeChatId) return
    setShowDiagnosticsModal(true)
  }, [selectedBookId, activeChatId])

  const handleDeleteEntry = useCallback(
    async (entryId: string) => {
      if (!selectedBookId) return
      try {
        await worldBooksApi.deleteEntry(selectedBookId, entryId)
        setEntries((prev) => prev.filter((e) => e.id !== entryId))
        setEntryTotal((prev) => Math.max(0, prev - 1))
        setEntryOffset((prev) => Math.max(0, prev - 1))
        if (selectedEntryId === entryId) setSelectedEntryId(null)
      } catch {}
    },
    [selectedBookId, selectedEntryId]
  )

  const updateEntry = useCallback(
    (entryId: string, updates: Record<string, any>) => {
      if (!selectedBookId) return
      setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, ...updates } : e)))
      void worldBooksApi.updateEntry(selectedBookId, entryId, updates)
        .then(() => loadVectorSummary(selectedBookId))
        .catch(() => {})
    },
    [selectedBookId, loadVectorSummary]
  )

  const debouncedUpdateEntry = useCallback(
    (entryId: string, updates: Record<string, any>) => {
      if (!selectedBookId) return
      setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, ...updates } : e)))
      const key = `${entryId}-${Object.keys(updates).join(',')}`
      clearTimeout(entryTimers.current[key])
      entryTimers.current[key] = setTimeout(() => {
        void worldBooksApi.updateEntry(selectedBookId, entryId, updates)
          .then(() => loadVectorSummary(selectedBookId))
          .catch(() => {})
      }, 2000)
    },
    [selectedBookId, loadVectorSummary]
  )

  const handleImport = useCallback((result: WorldBookImportResult) => {
    setBooks((prev) => [result.world_book, ...prev])
    setSelectedBookId(result.world_book.id)
    setShowImport(false)
    setPostImportBook(result.world_book)
  }, [])

  const handlePopOut = useCallback(() => {
    openModal('worldBookEditor', { bookId: selectedBookId })
  }, [openModal, selectedBookId])

  // Global world books popover
  const [globalPopoverOpen, setGlobalPopoverOpen] = useState(false)
  const globalPopoverRef = useRef<HTMLDivElement>(null)
  const globalAddBtnRef = useRef<HTMLButtonElement>(null)
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!globalPopoverOpen) return
    const handleClick = (e: MouseEvent) => {
      if (
        globalPopoverRef.current && !globalPopoverRef.current.contains(e.target as Node) &&
        globalAddBtnRef.current && !globalAddBtnRef.current.contains(e.target as Node)
      ) {
        setGlobalPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [globalPopoverOpen])

  const openGlobalPopover = useCallback(() => {
    setGlobalPopoverOpen((prev) => {
      const next = !prev
      if (next && globalAddBtnRef.current) {
        const rect = globalAddBtnRef.current.getBoundingClientRect()
        setPopoverPos({ top: rect.bottom + 4, left: rect.right })
      }
      return next
    })
  }, [])

  const toggleGlobalBook = (id: string) => {
    const current = globalWorldBooks ?? []
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id]
    setSetting('globalWorldBooks', next)
  }

  const removeGlobalBook = (id: string) => {
    setSetting('globalWorldBooks', (globalWorldBooks ?? []).filter((x) => x !== id))
  }

  const activeGlobalBooks = books.filter((b) => (globalWorldBooks ?? []).includes(b.id))
  const selectedBook = books.find((book) => book.id === selectedBookId) ?? null

  return (
    <div className={styles.panel}>
      {/* Global world books section */}
      <div className={styles.globalSection}>
        <div className={styles.globalHeader}>
          <Globe size={12} className={styles.globalIcon} />
          <span className={styles.globalLabel}>Always Active</span>
          <div className={styles.globalPopoverWrapper}>
            <button
              ref={globalAddBtnRef}
              type="button"
              className={styles.globalAddBtn}
              onClick={openGlobalPopover}
            >
              <Plus size={11} />
              <span>Add</span>
              <ChevronDown
                size={10}
                className={clsx(styles.chevron, globalPopoverOpen && styles.chevronOpen)}
              />
            </button>
            {globalPopoverOpen && popoverPos && createPortal(
              <div
                ref={globalPopoverRef}
                className={styles.globalPopover}
                style={{ top: popoverPos.top, left: popoverPos.left }}
              >
                {books.length === 0 ? (
                  <div className={styles.globalPopoverEmpty}>No world books available</div>
                ) : (
                  books.map((book) => {
                    const isActive = (globalWorldBooks ?? []).includes(book.id)
                    return (
                      <button
                        key={book.id}
                        type="button"
                        className={clsx(styles.globalPopoverItem, isActive && styles.globalPopoverItemActive)}
                        onClick={() => toggleGlobalBook(book.id)}
                      >
                        <span className={styles.globalPopoverCheck}>{isActive ? '\u2713' : ''}</span>
                        <span className={styles.globalPopoverName}>{book.name}</span>
                      </button>
                    )
                  })
                )}
              </div>,
              document.body
            )}
          </div>
        </div>
        {activeGlobalBooks.length > 0 ? (
          <div className={styles.globalPills}>
            {activeGlobalBooks.map((book) => (
              <span key={book.id} className={styles.globalPill}>
                <span className={styles.globalPillName}>{book.name}</span>
                <button
                  type="button"
                  className={styles.globalPillRemove}
                  onClick={() => removeGlobalBook(book.id)}
                  title="Remove from always active"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <span className={styles.globalHint}>No global world books active</span>
        )}
      </div>

      {/* Activation Settings */}
      <div className={styles.wiSettingsSection}>
        <button
          type="button"
          className={styles.wiSettingsToggle}
          onClick={() => setWiSettingsOpen((o) => !o)}
        >
          <Settings size={12} />
          <span>Activation Settings</span>
          <ChevronDown
            size={10}
            className={clsx(styles.chevron, wiSettingsOpen && styles.chevronOpen)}
          />
        </button>
        {wiSettingsOpen && (
          <WorldInfoSettingsForm
            settings={worldInfoSettings}
            onChange={(patch) => setSetting('worldInfoSettings', { ...worldInfoSettings, ...patch })}
          />
        )}
      </div>

      {/* Top bar: Book selector + actions */}
      <div className={styles.topBar}>
        <select
          className={styles.bookSelect}
          value={selectedBookId || ''}
          onChange={(e) => setSelectedBookId(e.target.value || null)}
        >
          <option value="">Select a book...</option>
          {books.map((book) => (
            <option key={book.id} value={book.id}>
              {book.name}
            </option>
          ))}
        </select>
        {(() => {
          const sel = books.find((b) => b.id === selectedBookId)
          if (sel?.metadata?.source === 'character') return (
            <span className={styles.sourceBadge} data-tooltip="From character">
              <User size={11} />
            </span>
          )
          if (sel?.metadata?.source === 'import') return (
            <span className={styles.sourceBadge} data-tooltip="Imported from file">
              <FileUp size={11} />
            </span>
          )
          return null
        })()}
        <button
          type="button"
          className={styles.iconBtn}
          onClick={handleCreateBook}
          title="New Book"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => setShowImport(true)}
          title="Import Book"
        >
          <Upload size={14} />
        </button>
        {!isMobile && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={handlePopOut}
            title="Pop out to modal"
          >
            <Maximize2 size={14} />
          </button>
        )}
      </div>

      {selectedBookId ? (
        <>
          {/* Book fields (collapsible) */}
          <button
            type="button"
            className={styles.bookFieldsToggle}
            onClick={() => setBookFieldsOpen((o) => !o)}
          >
            <BookOpen size={12} />
            <span className={styles.bookFieldsLabel}>{bookName || 'Book Details'}</span>
            <ChevronDown
              size={12}
              className={clsx(styles.chevron, bookFieldsOpen && styles.chevronOpen)}
            />
          </button>

          {bookFieldsOpen && (
            <div className={styles.bookFields}>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Name</label>
                <input
                  type="text"
                  className={styles.fieldInput}
                  value={bookName}
                  onChange={(e) => handleBookNameChange(e.target.value)}
                />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Description</label>
                <input
                  type="text"
                  className={styles.fieldInput}
                  value={bookDescription}
                  onChange={(e) => handleBookDescChange(e.target.value)}
                  placeholder="Optional description..."
                />
              </div>
              <button
                type="button"
                className={styles.deleteBookBtn}
                onClick={() => setDeleteBookConfirm(selectedBookId)}
              >
                <Trash2 size={11} />
                Delete Book
              </button>
              {vectorSummary && (
                <div className={styles.vectorSummary}>
                  <div className={styles.vectorSummaryTitle}>Semantic activation status</div>
                  <div className={styles.vectorSummaryGrid}>
                    <span>{vectorSummary.enabled} enabled</span>
                    <span>{vectorSummary.enabled_non_empty}/{vectorSummary.non_empty} non-empty</span>
                    <span>{vectorSummary.indexed} indexed</span>
                    <span>{vectorSummary.pending} pending</span>
                    <span>{vectorSummary.error} errors</span>
                  </div>
                  <label className={styles.bulkSemanticToggle}>
                    <input
                      ref={bulkSemanticToggleRef}
                      type="checkbox"
                      className={styles.bulkSemanticCheckbox}
                      checked={allNonEmptySemanticEnabled}
                      disabled={semanticUpdating || nonEmptyEntryCount === 0}
                      onChange={(event) => handleBulkSemanticActivation(event.target.checked)}
                    />
                    <span className={styles.bulkSemanticBody}>
                      <span className={styles.bulkSemanticTitle}>Use semantic activation for all non-empty entries</span>
                      <span className={styles.bulkSemanticMeta}>
                        {nonEmptyEntryCount > 0
                          ? `${enabledNonEmptyCount} of ${nonEmptyEntryCount} non-empty entries are opted in.`
                          : 'Add content to at least one entry before enabling semantic activation.'}
                      </span>
                    </span>
                  </label>
                  <span className={styles.bulkSemanticHint}>
                    This only changes entry opt-in. Reindex semantic search after changing it.
                  </span>
                </div>
              )}
              <div className={styles.bookActionRow}>
                <button
                  type="button"
                  className={styles.primaryActionBtn}
                  onClick={handleReindexVectors}
                  disabled={reindexing}
                >
                  {reindexing ? 'Reindexing...' : 'Reindex semantic search'}
                </button>
                <button
                  type="button"
                  className={styles.subtleActionBtn}
                  onClick={handleDiagnostics}
                  disabled={!activeChatId}
                >
                  <Search size={12} />
                  <span>Diagnose Current Chat</span>
                </button>
              </div>
              {vectorStatus && <span className={styles.vectorStatusText}>{vectorStatus}</span>}
            </div>
          )}

          {/* Entries header */}
          <div className={styles.entryListHeader}>
            <span className={styles.entryListTitle}>
              Entries ({entryTotal})
            </span>
            <button
              type="button"
              className={styles.newEntryBtn}
              onClick={handleCreateEntry}
            >
              <Plus size={12} />
              <span>New</span>
            </button>
          </div>

          {/* Entry list */}
          <div className={styles.entryList}>
            {entries.map((entry) => (
              <div key={entry.id}>
                <div
                  className={clsx(styles.entryRow, selectedEntryId === entry.id && styles.entryRowActive)}
                  onClick={() => setSelectedEntryId(entry.id === selectedEntryId ? null : entry.id)}
                >
                  <span className={styles.entryComment}>
                    {entry.comment || '(unnamed)'}
                  </span>
                  <span className={styles.entryKeys}>
                    {entry.key.length > 0 ? entry.key.join(', ') : '-'}
                  </span>
                  <input
                    type="checkbox"
                    className={styles.entryToggle}
                    checked={!entry.disabled}
                    title={entry.disabled ? 'Disabled' : 'Enabled'}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => updateEntry(entry.id, { disabled: !entry.disabled })}
                  />
                  <span
                    className={styles.entryDeleteBtn}
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteEntryConfirm(entry.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation()
                        setDeleteEntryConfirm(entry.id)
                      }
                    }}
                  >
                    <Trash2 size={11} />
                  </span>
                </div>
                {/* Inline editor below selected entry */}
                {selectedEntryId === entry.id && (
                  <WorldBookEntryEditor
                    entry={entry}
                    onUpdate={debouncedUpdateEntry}
                    onImmediateUpdate={updateEntry}
                  />
                )}
              </div>
            ))}
            {entries.length === 0 && (
              <div className={styles.emptyState}>No entries yet</div>
            )}
            {entries.length < entryTotal && (
              <button
                type="button"
                className={styles.newEntryBtn}
                onClick={loadMoreEntries}
                disabled={loadingMore}
                style={{ margin: '8px auto', display: 'block' }}
              >
                {loadingMore ? 'Loading...' : `Load More (${entries.length}/${entryTotal})`}
              </button>
            )}
          </div>

        </>
      ) : (
        <div className={styles.emptyState}>
          Select a book or create a new one
        </div>
      )}

      {/* Delete book confirmation */}
      {deleteBookConfirm && (
        <ConfirmationModal
          isOpen={true}
          title="Delete World Book"
          message="Delete this book and all its entries? This cannot be undone."
          variant="danger"
          confirmText="Delete"
          onConfirm={async () => {
            await handleDeleteBook(deleteBookConfirm)
            setDeleteBookConfirm(null)
          }}
          onCancel={() => setDeleteBookConfirm(null)}
        />
      )}

      {/* Delete entry confirmation */}
      {deleteEntryConfirm && (
        <ConfirmationModal
          isOpen={true}
          title="Delete Entry"
          message="Delete this entry? This cannot be undone."
          variant="danger"
          confirmText="Delete"
          onConfirm={async () => {
            await handleDeleteEntry(deleteEntryConfirm)
            setDeleteEntryConfirm(null)
          }}
          onCancel={() => setDeleteEntryConfirm(null)}
        />
      )}

      {/* Import modal */}
      {showImport && (
        <ImportWorldBookModal
          onImport={handleImport}
          onClose={() => setShowImport(false)}
        />
      )}

      {postImportBook && (
        <PostImportWorldBookModal
          book={postImportBook}
          onClose={() => setPostImportBook(null)}
        />
      )}

      {showDiagnosticsModal && selectedBook && activeChatId && (
        <WorldBookDiagnosticsModal
          book={selectedBook}
          chatId={activeChatId}
          onClose={() => setShowDiagnosticsModal(false)}
        />
      )}
    </div>
  )
}

function WorldInfoSettingsForm({
  settings,
  onChange,
}: {
  settings: WorldInfoSettings
  onChange: (patch: Partial<WorldInfoSettings>) => void
}) {
  return (
    <div className={styles.wiSettingsBody}>
      <div className={styles.wiField}>
        <label className={styles.wiFieldLabel}>GLOBAL SCAN DEPTH</label>
        <p className={styles.wiFieldHint}>
          Default scan depth for entries without a per-entry setting. Controls how many recent messages are scanned for keywords.
        </p>
        <div className={styles.wiFieldRow}>
          <input
            type="number"
            className={styles.wiFieldInput}
            min={0}
            max={200}
            placeholder="Unlimited"
            value={settings.globalScanDepth ?? ''}
            onChange={(e) => {
              const v = e.target.value.trim()
              onChange({ globalScanDepth: v === '' ? null : Math.max(0, parseInt(v, 10) || 0) })
            }}
          />
          {settings.globalScanDepth != null && (
            <button type="button" className={styles.wiFieldClear} onClick={() => onChange({ globalScanDepth: null })}>
              <X size={10} />
            </button>
          )}
        </div>
      </div>

      <div className={styles.wiField}>
        <label className={styles.wiFieldLabel}>MAX RECURSION PASSES</label>
        <p className={styles.wiFieldHint}>
          How many recursive keyword-chaining passes to run. 0 disables recursion entirely.
        </p>
        <div className={styles.wiFieldRow}>
          <input
            type="range"
            className={styles.wiRange}
            min={0}
            max={10}
            value={settings.maxRecursionPasses}
            onChange={(e) => onChange({ maxRecursionPasses: parseInt(e.target.value, 10) })}
          />
          <span className={styles.wiRangeValue}>{settings.maxRecursionPasses}</span>
        </div>
      </div>

      <div className={styles.wiField}>
        <label className={styles.wiFieldLabel}>MAX ACTIVATED ENTRIES</label>
        <p className={styles.wiFieldHint}>
          Cap the total number of activated entries per generation. 0 = unlimited. Highest-priority entries survive; constants are never evicted.
        </p>
        <input
          type="number"
          className={styles.wiFieldInput}
          min={0}
          max={500}
          placeholder="Unlimited"
          value={settings.maxActivatedEntries || ''}
          onChange={(e) => onChange({ maxActivatedEntries: Math.max(0, parseInt(e.target.value, 10) || 0) })}
        />
      </div>

      <div className={styles.wiField}>
        <label className={styles.wiFieldLabel}>MAX TOKEN BUDGET</label>
        <p className={styles.wiFieldHint}>
          Approximate max WI content in tokens. 0 = unlimited. Entries included in priority order until budget is met.
        </p>
        <input
          type="number"
          className={styles.wiFieldInput}
          min={0}
          max={50000}
          step={100}
          placeholder="Unlimited"
          value={settings.maxTokenBudget || ''}
          onChange={(e) => onChange({ maxTokenBudget: Math.max(0, parseInt(e.target.value, 10) || 0) })}
        />
      </div>

      <div className={styles.wiField}>
        <label className={styles.wiFieldLabel}>MIN PRIORITY THRESHOLD</label>
        <p className={styles.wiFieldHint}>
          Entries below this priority are excluded entirely. Constants are exempt. 0 = no filter.
        </p>
        <div className={styles.wiFieldRow}>
          <input
            type="range"
            className={styles.wiRange}
            min={0}
            max={100}
            value={settings.minPriority}
            onChange={(e) => onChange({ minPriority: parseInt(e.target.value, 10) })}
          />
          <span className={styles.wiRangeValue}>{settings.minPriority}</span>
        </div>
      </div>
    </div>
  )
}
