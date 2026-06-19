import { useState, useEffect, useCallback, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Plus, Trash2, BookOpen, Upload, User, FileUp, Search } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Toggle } from '@/components/shared/Toggle'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { worldBooksApi } from '@/api/world-books'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import ImportWorldBookModal, { type WorldBookImportResult } from './ImportWorldBookModal'
import PostImportWorldBookModal from '@/components/shared/PostImportWorldBookModal'
import WorldBookDiagnosticsModal from '@/components/panels/world-book/WorldBookDiagnosticsModal'
import { formatWorldBookReindexStatus } from '@/lib/worldBookVectorization'
import WorldBookEntryEditor from '@/components/shared/WorldBookEntryEditor'
import WorldBookEntriesSection from '@/components/shared/WorldBookEntriesSection'
import FolderDropdown from '@/components/shared/FolderDropdown'
import { useFolders } from '@/hooks/useFolders'
import Pagination from '@/components/shared/Pagination'
import type { WorldBook, WorldBookEntry, WorldBookVectorSummary } from '@/types/api'

import styles from './WorldBookEditorModal.module.css'
import clsx from 'clsx'

type EntrySortBy = 'order' | 'priority' | 'created' | 'updated' | 'name'
type EntrySortDir = 'asc' | 'desc'

export default function WorldBookEditorModal() {
  const { t } = useTranslation('modals', { keyPrefix: 'worldBookEditor' })
  const { t: tp } = useTranslation('panels', { keyPrefix: 'worldBookPanel' })
  const { t: tc } = useTranslation('common')
  const closeModal = useStore((s) => s.closeModal)
  const modalProps = useStore((s) => s.modalProps)
  const activeChatId = useStore((s) => s.activeChatId)

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
  const [entryPage, setEntryPage] = useState(1)
  const [entrySearchFilter, setEntrySearchFilter] = useState('')
  const [entrySortBy, setEntrySortBy] = useState<EntrySortBy>('order')
  const [entrySortDir, setEntrySortDir] = useState<EntrySortDir>('asc')

  // Book editing state
  const [bookName, setBookName] = useState('')
  const [bookDescription, setBookDescription] = useState('')
  const [bookFolder, setBookFolder] = useState('')
  const [vectorSummary, setVectorSummary] = useState<WorldBookVectorSummary | null>(null)
  const { folders, createFolder } = useFolders('worldBookFolders', books)

  const [postImportBook, setPostImportBook] = useState<WorldBook | null>(null)

  // Confirmation modals
  const [deleteBookConfirm, setDeleteBookConfirm] = useState<string | null>(null)
  const [deleteEntryConfirm, setDeleteEntryConfirm] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [convertPreview, setConvertPreview] = useState<{
    total: number; eligible: number; constant_skipped: number
    already_vectorized: number; empty_skipped: number; disabled_skipped: number
  } | null>(null)
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false)

  // Debounce refs
  const bookNameTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const bookDescTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const entryTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const [debouncedEntrySearch, setDebouncedEntrySearch] = useState('')
  useEffect(() => {
    const trimmed = entrySearchFilter.trim()
    const handle = setTimeout(() => setDebouncedEntrySearch(trimmed), 200)
    return () => clearTimeout(handle)
  }, [entrySearchFilter])

  // Load books
  const loadBooks = useCallback(async () => {
    try {
      const res = await worldBooksApi.list({ limit: 1000 })
      setBooks(res.data)
    } catch {}
  }, [])

  useEffect(() => {
    loadBooks()
  }, [loadBooks])

  const ENTRIES_PAGE_SIZE = 50
  const entryTotalPages = Math.max(1, Math.ceil(entryTotal / ENTRIES_PAGE_SIZE))

  const loadEntries = useCallback(async (
    bookId: string,
    page: number,
    sortBy: EntrySortBy,
    sortDir: EntrySortDir,
    search: string,
  ) => {
    try {
      const res = await worldBooksApi.listEntries(bookId, {
        limit: ENTRIES_PAGE_SIZE,
        offset: (page - 1) * ENTRIES_PAGE_SIZE,
        sort_by: sortBy,
        sort_dir: sortDir,
        search: search || undefined,
      })
      setEntries(res.data)
      setEntryTotal(res.total)
      const lastPage = Math.max(1, Math.ceil(res.total / ENTRIES_PAGE_SIZE))
      if (page > lastPage) {
        setEntryPage(lastPage)
      }
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

  useEffect(() => {
    setEntryPage(1)
    setSelectedEntryId(null)
  }, [debouncedEntrySearch])

  useEffect(() => {
    if (!selectedBookId) return
    loadEntries(selectedBookId, entryPage, entrySortBy, entrySortDir, debouncedEntrySearch)
  }, [selectedBookId, entryPage, entrySortBy, entrySortDir, debouncedEntrySearch, loadEntries])

  useEffect(() => {
    if (selectedBookId) {
      loadVectorSummary(selectedBookId)
      const book = books.find((b) => b.id === selectedBookId)
      if (book) {
        setBookName(book.name)
        setBookDescription(book.description)
        setBookFolder(book.folder || '')
      }
      setEntrySearchFilter('')
      setSelectedEntryId(null)
      setShowDiagnosticsModal(false)
      setEntryPage(1)
    } else {
      setEntries([])
      setEntryTotal(0)
      setEntryPage(1)
      setEntrySearchFilter('')
      setSelectedEntryId(null)
      setVectorSummary(null)
      setShowDiagnosticsModal(false)
    }
  }, [selectedBookId, books, loadVectorSummary])

  const handleSortByChange = useCallback((value: EntrySortBy) => {
    setEntrySortBy(value)
    setEntryPage(1)
  }, [])

  const toggleSortDir = useCallback(() => {
    setEntrySortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    setEntryPage(1)
  }, [])

  const refetchCurrentPage = useCallback(() => {
    if (!selectedBookId) return
    loadEntries(selectedBookId, entryPage, entrySortBy, entrySortDir, debouncedEntrySearch)
  }, [selectedBookId, entryPage, entrySortBy, entrySortDir, debouncedEntrySearch, loadEntries])

  // Filtered books
  const filteredBooks = searchFilter
    ? books.filter((b) => b.name.toLowerCase().includes(searchFilter.toLowerCase()))
    : books

  // Book CRUD
  const handleCreateBook = useCallback(async () => {
    try {
      const book = await worldBooksApi.create({ name: t('newBookName') })
      setBooks((prev) => [book, ...prev])
      setSelectedBookId(book.id)
    } catch {}
  }, [t])

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

  const handleBookFolderChange = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      setBookFolder(trimmed)
      if (selectedBookId) {
        worldBooksApi.update(selectedBookId, { folder: trimmed })
        setBooks((prev) =>
          prev.map((b) => (b.id === selectedBookId ? { ...b, folder: trimmed } : b))
        )
      }
    },
    [selectedBookId]
  )

  // Entry CRUD
  const handleCreateEntry = useCallback(async () => {
    if (!selectedBookId) return
    try {
      const entry = await worldBooksApi.createEntry(selectedBookId, {
        comment: t('newEntryName'),
        key: [],
        content: '',
      })
      setSelectedEntryId(entry.id)
      await loadEntries(selectedBookId, entryPage, entrySortBy, entrySortDir, debouncedEntrySearch)
    } catch {}
  }, [selectedBookId, entryPage, entrySortBy, entrySortDir, debouncedEntrySearch, loadEntries, t])

  const handleDeleteEntry = useCallback(
    async (entryId: string) => {
      if (!selectedBookId) return
      try {
        await worldBooksApi.deleteEntry(selectedBookId, entryId)
        if (selectedEntryId === entryId) setSelectedEntryId(null)
        await loadEntries(selectedBookId, entryPage, entrySortBy, entrySortDir, debouncedEntrySearch)
      } catch {}
    },
    [selectedBookId, selectedEntryId, entryPage, entrySortBy, entrySortDir, debouncedEntrySearch, loadEntries]
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
      setVectorStatus(t('reindexing'))
      const result = await worldBooksApi.reindexVectors(selectedBookId, {
        onProgress: (p) => {
          setVectorStatus(t('reindexProgress', { status: formatWorldBookReindexStatus(p) }))
        },
      })
      const finalStatus = formatWorldBookReindexStatus(result)
      setVectorStatus(t('doneStatus', { status: finalStatus }))
      refetchCurrentPage()
      await loadVectorSummary(selectedBookId)
    } catch {
      setVectorStatus(t('reindexFailed'))
    } finally {
      setReindexing(false)
    }
  }, [selectedBookId, reindexing, refetchCurrentPage, loadVectorSummary, t])

  const handleConvertToVectorizedPreview = useCallback(async () => {
    if (!selectedBookId) return
    try {
      const preview = await worldBooksApi.getConvertToVectorizedPreview(selectedBookId)
      setConvertPreview(preview)
    } catch {
      setVectorStatus(t('previewFailed'))
    }
  }, [selectedBookId, t])

  const handleConvertToVectorized = useCallback(async () => {
    if (!selectedBookId) return
    setConvertPreview(null)
    try {
      setReindexing(true)
      const result = await worldBooksApi.convertToVectorized(selectedBookId)
      setVectorSummary(result.summary)
      setVectorStatus(t('convertedCount', { count: result.converted }))
      refetchCurrentPage()
      const reindexResult = await worldBooksApi.reindexVectors(selectedBookId, {
        onProgress: (p) => {
          setVectorStatus(t('reindexProgress', { status: formatWorldBookReindexStatus(p) }))
        },
      })
      const finalStatus = formatWorldBookReindexStatus(reindexResult)
      setVectorStatus(t('doneStatus', { status: finalStatus }))
      refetchCurrentPage()
      await loadVectorSummary(selectedBookId)
    } catch {
      setVectorStatus(t('convertFailed'))
    } finally {
      setReindexing(false)
    }
  }, [selectedBookId, refetchCurrentPage, loadVectorSummary, t])

  const handleDiagnostics = useCallback(() => {
    if (!selectedBookId || !activeChatId) return
    setShowDiagnosticsModal(true)
  }, [selectedBookId, activeChatId])

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
          <h2 className={styles.title}>{t('modalTitle')}</h2>
          <CloseButton onClick={closeModal} />
        </div>

        <div className={styles.body}>
          {/* Left panel: Book list */}
          <div className={styles.sidebar}>
            <div className={styles.sidebarHeader}>
              <input
                type="text"
                className={styles.searchInput}
                placeholder={t('searchPlaceholder')}
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
              />
              <button
                type="button"
                className={styles.newBookBtn}
                onClick={handleCreateBook}
                title={t('createTitle')}
              >
                <Plus size={14} />
              </button>
              <button
                type="button"
                className={styles.newBookBtn}
                onClick={() => setShowImport(true)}
                title={t('importTitle')}
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
                    <span className={styles.sourceBadge} data-tooltip={t('fromCharacterTooltip')}>
                      <User size={10} />
                    </span>
                  )}
                  {book.metadata?.source === 'import' && (
                    <span className={styles.sourceBadge} data-tooltip={t('importedTooltip')}>
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
                <div className={styles.emptyState}>{t('noBooksFound')}</div>
              )}
            </div>
          </div>

          {/* Right panel: Book content */}
          {selectedBookId ? (
            <div className={styles.content}>
              {/* Book name & description */}
              <div className={styles.bookFields}>
                <div className={styles.fieldRow}>
                  <label className={styles.fieldLabel}>{tp('name')}</label>
                  <input
                    type="text"
                    className={styles.fieldInput}
                    value={bookName}
                    onChange={(e) => handleBookNameChange(e.target.value)}
                  />
                </div>
                <div className={styles.fieldRow}>
                  <label className={styles.fieldLabel}>{tp('description')}</label>
                  <input
                    type="text"
                    className={styles.fieldInput}
                    value={bookDescription}
                    onChange={(e) => handleBookDescChange(e.target.value)}
                  />
                </div>
                <div className={styles.fieldRow}>
                  <label className={styles.fieldLabel}>{tp('folder')}</label>
                  <FolderDropdown
                    folders={folders}
                    selectedFolder={bookFolder}
                    onSelect={handleBookFolderChange}
                    onCreateFolder={createFolder}
                  />
                </div>
                {vectorSummary && (
                  <div className={styles.vectorSummary}>
                    <div className={styles.vectorSummaryTitle}>{tp('vectorStatusTitle')}</div>
                    <div className={styles.vectorSummaryGrid}>
                      <span>{tp('vectorEnabled', { count: vectorSummary.enabled })}</span>
                      <span>{tp('vectorNonEmpty', { enabled: vectorSummary.enabled_non_empty, total: vectorSummary.non_empty })}</span>
                      <span>{tp('vectorIndexed', { count: vectorSummary.indexed })}</span>
                      <span>{tp('vectorPending', { count: vectorSummary.pending })}</span>
                      <span>{tp('vectorErrors', { count: vectorSummary.error })}</span>
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
                    {reindexing ? tp('reindexing') : t('reindexButton')}
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={handleConvertToVectorizedPreview}
                    disabled={reindexing}
                  >
                    {tp('convertToVectorized')}
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={handleDiagnostics}
                    disabled={!activeChatId}
                  >
                    <Search size={12} />
                    {t('diagnoseCurrentChat')}
                  </button>
                  {vectorStatus && (
                    <span className={styles.vectorStatusText}>{vectorStatus}</span>
                  )}
                </div>
              </div>

              <WorldBookEntriesSection
                books={books}
                selectedBookId={selectedBookId}
                onRefreshVectorSummary={loadVectorSummary}
              />
            </div>
          ) : (
            <div className={styles.content}>
              <div className={styles.emptyState}>
                {t('selectOrCreate')}
              </div>
            </div>
          )}
        </div>
    </ModalShell>

      {/* Delete book confirmation */}
      {deleteBookConfirm && (
        <ConfirmationModal
          isOpen={true}
          title={t('deleteBookTitle')}
          message={t('deleteBookMessage')}
          variant="danger"
          confirmText={tc('actions.delete')}
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
          title={t('deleteEntryTitle')}
          message={t('deleteEntryMessage')}
          variant="danger"
          confirmText={tc('actions.delete')}
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

      {/* Convert to vectorized confirmation */}
      {convertPreview && (
        <ConfirmationModal
          isOpen={true}
          title={t('convertTitle')}
          message={
            convertPreview.eligible === 0
              ? t('convertNoneEligible')
              : (
                <>
                  <p>
                    <Trans
                      i18nKey="modals:worldBookEditor.convertConfirm"
                      values={{
                        count: convertPreview.eligible,
                        entryWord: convertPreview.eligible === 1 ? t('entry') : t('entries'),
                      }}
                      components={{ strong: <strong /> }}
                    />
                  </p>
                  <ul style={{ textAlign: 'left', margin: '8px 0', paddingLeft: '20px', fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))', opacity: 0.8 }}>
                    {convertPreview.constant_skipped > 0 && (
                      <li>{t('constantSkipped', {
                        count: convertPreview.constant_skipped,
                        entryWord: convertPreview.constant_skipped === 1 ? t('entry') : t('entries'),
                      })}</li>
                    )}
                    {convertPreview.already_vectorized > 0 && (
                      <li>{t('alreadySkipped', {
                        count: convertPreview.already_vectorized,
                        entryWord: convertPreview.already_vectorized === 1 ? t('entry') : t('entries'),
                      })}</li>
                    )}
                    {convertPreview.empty_skipped > 0 && (
                      <li>{t('emptySkipped', {
                        count: convertPreview.empty_skipped,
                        entryWord: convertPreview.empty_skipped === 1 ? t('entry') : t('entries'),
                      })}</li>
                    )}
                    {convertPreview.disabled_skipped > 0 && (
                      <li>{t('disabledSkipped', {
                        count: convertPreview.disabled_skipped,
                        entryWord: convertPreview.disabled_skipped === 1 ? t('entry') : t('entries'),
                      })}</li>
                    )}
                  </ul>
                </>
              )
          }
          variant="safe"
          confirmText={convertPreview.eligible > 0 ? t('convertConfirmButton') : tp('ok')}
          onConfirm={convertPreview.eligible > 0 ? handleConvertToVectorized : () => setConvertPreview(null)}
          onCancel={() => setConvertPreview(null)}
        />
      )}

      {/* Diagnostics modal */}
      {showDiagnosticsModal && selectedBookId && activeChatId && (
        <WorldBookDiagnosticsModal
          book={books.find((b) => b.id === selectedBookId)!}
          chatId={activeChatId}
          onClose={() => setShowDiagnosticsModal(false)}
        />
      )}
    </>
  )
}
