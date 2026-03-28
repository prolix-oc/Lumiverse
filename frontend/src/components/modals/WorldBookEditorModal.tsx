import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Trash2, BookOpen, Upload, User, FileUp, Search } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Toggle } from '@/components/shared/Toggle'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { worldBooksApi } from '@/api/world-books'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import ImportWorldBookModal, { type WorldBookImportResult } from './ImportWorldBookModal'
import PostImportWorldBookModal from '@/components/shared/PostImportWorldBookModal'
import { formatWorldBookReindexStatus } from '@/lib/worldBookVectorization'
import WorldBookEntryEditor from '@/components/shared/WorldBookEntryEditor'
import type { WorldBook, WorldBookEntry, WorldBookVectorSummary } from '@/types/api'
import styles from './WorldBookEditorModal.module.css'
import clsx from 'clsx'

const POSITION_SHORT = ['Before Main', 'After Main', 'Before AN', 'After AN', '@ Depth']

export default function WorldBookEditorModal() {
  const closeModal = useStore((s) => s.closeModal)
  const modalProps = useStore((s) => s.modalProps)

  // Book list state
  const [books, setBooks] = useState<WorldBook[]>([])
  const [searchFilter, setSearchFilter] = useState('')
  const [selectedBookId, setSelectedBookId] = useState<string | null>(
    (modalProps.bookId as string) || null
  )

  // Entry state
  const [entries, setEntries] = useState<WorldBookEntry[]>([])
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [entryTotal, setEntryTotal] = useState(0)
  const [entryOffset, setEntryOffset] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [entrySearchFilter, setEntrySearchFilter] = useState('')

  // Book editing state
  const [bookName, setBookName] = useState('')
  const [bookDescription, setBookDescription] = useState('')
  const [vectorSummary, setVectorSummary] = useState<WorldBookVectorSummary | null>(null)

  const [postImportBook, setPostImportBook] = useState<WorldBook | null>(null)

  // Confirmation modals
  const [deleteBookConfirm, setDeleteBookConfirm] = useState<string | null>(null)
  const [deleteEntryConfirm, setDeleteEntryConfirm] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)

  // Debounce refs
  const bookNameTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const bookDescTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const entryTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const normalizedEntrySearch = entrySearchFilter.trim().toLowerCase()
  const filteredEntries = normalizedEntrySearch
    ? entries.filter((entry) =>
        [entry.comment, entry.content, ...entry.key, ...entry.keysecondary]
          .join('\n')
          .toLowerCase()
          .includes(normalizedEntrySearch)
      )
    : entries

  useEffect(() => {
    if (!selectedEntryId) return
    if (!filteredEntries.some((entry) => entry.id === selectedEntryId)) {
      setSelectedEntryId(null)
    }
  }, [filteredEntries, selectedEntryId])

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
      setEntrySearchFilter('')
      setSelectedEntryId(null)
    } else {
      setEntries([])
      setEntryTotal(0)
      setEntryOffset(0)
      setEntrySearchFilter('')
      setSelectedEntryId(null)
      setVectorSummary(null)
    }
  }, [selectedBookId, books, loadEntries, loadVectorSummary])

  // Filtered books
  const filteredBooks = searchFilter
    ? books.filter((b) => b.name.toLowerCase().includes(searchFilter.toLowerCase()))
    : books

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
      }, 400)
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
      }, 400)
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
      }, 400)
    },
    [selectedBookId, loadVectorSummary]
  )

  const [vectorStatus, setVectorStatus] = useState<string | null>(null)
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

  const handleImport = useCallback((result: WorldBookImportResult) => {
    setBooks((prev) => [result.world_book, ...prev])
    setSelectedBookId(result.world_book.id)
    setShowImport(false)
    setPostImportBook(result.world_book)
  }, [])

  return (
    <>
    <ModalShell isOpen={true} onClose={closeModal} maxWidth="clamp(340px, 92vw, min(1160px, var(--lumiverse-content-max-width, 1160px)))" zIndex={10001} className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title}>World Book Editor</h2>
          <CloseButton onClick={closeModal} />
        </div>

        <div className={styles.body}>
          {/* Left panel: Book list */}
          <div className={styles.sidebar}>
            <div className={styles.sidebarHeader}>
              <input
                type="text"
                className={styles.searchInput}
                placeholder="Search books..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
              />
              <button
                type="button"
                className={styles.newBookBtn}
                onClick={handleCreateBook}
                title="Create new book"
              >
                <Plus size={14} />
              </button>
              <button
                type="button"
                className={styles.newBookBtn}
                onClick={() => setShowImport(true)}
                title="Import book"
              >
                <Upload size={14} />
              </button>
            </div>
            <div className={styles.bookList}>
              {filteredBooks.map((book) => (
                <button
                  key={book.id}
                  type="button"
                  className={clsx(styles.bookItem, selectedBookId === book.id && styles.bookItemActive)}
                  onClick={() => setSelectedBookId(book.id)}
                >
                  <BookOpen size={13} />
                  <span className={styles.bookName}>{book.name}</span>
                  {book.metadata?.source === 'character' && (
                    <span className={styles.sourceBadge} data-tooltip={`From character${book.metadata.source_character_id ? '' : ''}`}>
                      <User size={10} />
                    </span>
                  )}
                  {book.metadata?.source === 'import' && (
                    <span className={styles.sourceBadge} data-tooltip="Imported from file">
                      <FileUp size={10} />
                    </span>
                  )}
                  <span
                    className={styles.bookDeleteBtn}
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteBookConfirm(book.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation()
                        setDeleteBookConfirm(book.id)
                      }
                    }}
                  >
                    <Trash2 size={11} />
                  </span>
                </button>
              ))}
              {filteredBooks.length === 0 && (
                <div className={styles.emptyState}>No books found</div>
              )}
            </div>
          </div>

          {/* Right panel: Book content */}
          {selectedBookId ? (
            <div className={styles.content}>
              {/* Book name & description */}
              <div className={styles.bookFields}>
                <div className={styles.fieldRow}>
                  <label className={styles.fieldLabel}>Name</label>
                  <input
                    type="text"
                    className={styles.fieldInput}
                    value={bookName}
                    onChange={(e) => handleBookNameChange(e.target.value)}
                  />
                </div>
                <div className={styles.fieldRow}>
                  <label className={styles.fieldLabel}>Description</label>
                  <input
                    type="text"
                    className={styles.fieldInput}
                    value={bookDescription}
                    onChange={(e) => handleBookDescChange(e.target.value)}
                  />
                </div>
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
                  {vectorStatus && (
                    <span className={styles.vectorStatusText}>{vectorStatus}</span>
                  )}
                </div>
              </div>

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
                  <span>New Entry</span>
                </button>
              </div>

              <label className={styles.entrySearch}>
                <Search size={14} className={styles.entrySearchIcon} />
                <input
                  type="text"
                  className={styles.entrySearchInput}
                  placeholder="Search entries..."
                  value={entrySearchFilter}
                  onChange={(e) => setEntrySearchFilter(e.target.value)}
                />
              </label>

              {/* Entry list */}
              <div className={styles.entryList}>
                {filteredEntries.map((entry) => (
                  <div key={entry.id}>
                    <div
                      className={clsx(styles.entryRow, selectedEntryId === entry.id && styles.entryRowActive, entry.disabled && styles.entryRowDisabled)}
                      onClick={() => setSelectedEntryId(entry.id === selectedEntryId ? null : entry.id)}
                    >
                      <div className={styles.entryTop}>
                        <span className={styles.entryComment}>
                          {entry.comment || '(unnamed)'}
                        </span>
                        <span onClick={(e) => e.stopPropagation()}>
                          <Toggle.Checkbox
                            checked={!entry.disabled}
                            onChange={() => updateEntry(entry.id, { disabled: !entry.disabled })}
                            className={styles.entryToggle}
                          />
                        </span>
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
                      <div className={styles.entryMeta}>
                        <span className={clsx(styles.entryBadge, entry.constant ? styles.badgeConstant : entry.vectorized ? styles.badgeVector : styles.badgeTrigger)}>
                          {entry.constant ? 'Constant' : entry.vectorized ? 'Vector' : 'Trigger'}
                        </span>
                        <span className={styles.entryMetaItem}>Ord: {entry.order_value}</span>
                        {entry.position === 4
                          ? <span className={styles.entryMetaItem}>@ Depth {entry.depth}</span>
                          : <span className={styles.entryMetaItem}>{POSITION_SHORT[entry.position] ?? `Pos ${entry.position}`}</span>
                        }
                      </div>
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
                  <div className={styles.entryEmptyState}>No entries yet</div>
                )}
                {entries.length > 0 && filteredEntries.length === 0 && (
                  <div className={styles.entryEmptyState}>No entries match your search</div>
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
            </div>
          ) : (
            <div className={styles.content}>
              <div className={styles.emptyState}>
                Select a world book or create a new one
              </div>
            </div>
          )}
        </div>
    </ModalShell>

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
    </>
  )
}
