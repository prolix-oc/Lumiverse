import { useState, useEffect, useCallback, useRef, useMemo, type KeyboardEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Plus, Trash2, BookOpen, Upload, User, FileUp, Search, Download, ArrowUp, ArrowDown, ArrowUpDown, CheckSquare, Square } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { worldBooksApi } from '@/api/world-books'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import ImportWorldBookModal, { type WorldBookImportResult } from './ImportWorldBookModal'
import PostImportWorldBookModal from '@/components/shared/PostImportWorldBookModal'
import WorldBookDiagnosticsModal from '@/components/panels/world-book/WorldBookDiagnosticsModal'
import { formatWorldBookReindexStatus } from '@/lib/worldBookVectorization'
import WorldBookEntriesSection from '@/components/shared/WorldBookEntriesSection'
import FolderDropdown from '@/components/shared/FolderDropdown'
import { useFolders } from '@/hooks/useFolders'
import { useWorldBookListLiveSync } from '@/hooks/useWorldBookListLiveSync'
import Pagination from '@/components/shared/Pagination'
import { triggerBlobDownload } from '@/lib/downloads'
import type { WorldBook, WorldBookVectorSummary } from '@/types/api'
import type { WorldBookExportFormat } from '@/api/world-books'

import styles from './WorldBookEditorModal.module.css'
import clsx from 'clsx'

const BOOK_SORT_OPTIONS = [
  { value: 'updated', labelKey: 'sortRecent' },
  { value: 'name', labelKey: 'sortName' },
] as const

const BOOK_PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 'all'] as const

const BOOK_EXPORT_FORMAT_OPTIONS = [
  { value: 'lumiverse', labelKey: 'exportFormatLumiverse' },
  { value: 'character_book', labelKey: 'exportFormatCharacterBook' },
  { value: 'sillytavern', labelKey: 'exportFormatSillyTavern' },
] as const

type BookSortBy = (typeof BOOK_SORT_OPTIONS)[number]['value']
type BookSortDir = 'asc' | 'desc'
type BookPageSize = (typeof BOOK_PAGE_SIZE_OPTIONS)[number]

function getBlobFilename(blob: Blob): string | null {
  return typeof File !== 'undefined' && blob instanceof File && blob.name ? blob.name : null
}

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
  const [sortBy, setSortBy] = useState<BookSortBy>('updated')
  const [sortDir, setSortDir] = useState<BookSortDir>('desc')
  const [pageSize, setPageSize] = useState<BookPageSize>(50)
  const [page, setPage] = useState(1)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())

  // Book editing state
  const [bookName, setBookName] = useState('')
  const [bookDescription, setBookDescription] = useState('')
  const [bookFolder, setBookFolder] = useState('')
  const [vectorSummary, setVectorSummary] = useState<WorldBookVectorSummary | null>(null)
  const { folders, createFolder } = useFolders('worldBookFolders', books)

  const [postImportBook, setPostImportBook] = useState<WorldBook | null>(null)

  // Confirmation modals
  const [deleteBookConfirm, setDeleteBookConfirm] = useState<string | null>(null)
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState<string[] | null>(null)
  const [bulkExportIds, setBulkExportIds] = useState<string[] | null>(null)
  const [bulkExportFormat, setBulkExportFormat] = useState<WorldBookExportFormat>('lumiverse')
  const [bulkActionPending, setBulkActionPending] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [convertPreview, setConvertPreview] = useState<{
    total: number; eligible: number; keys_retained?: number; constant_skipped: number
    already_vectorized: number; empty_skipped: number; disabled_skipped: number
  } | null>(null)
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false)

  // Debounce refs
  const bookNameTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const bookDescTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

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

  // Live-sync the book list with changes from other tabs/devices or Spindle.
  const { markLocalBookEdit } = useWorldBookListLiveSync({
    selectedBookId,
    setBooks,
    onSelectedBookDeleted: () => setSelectedBookId(null),
    refreshBooks: loadBooks,
  })

  const loadVectorSummary = useCallback(async (bookId: string) => {
    try {
      const summary = await worldBooksApi.getVectorSummary(bookId)
      setVectorSummary(summary)
    } catch {
      setVectorSummary(null)
    }
  }, [])

  useEffect(() => {
    if (selectedBookId) {
      loadVectorSummary(selectedBookId)
      const book = books.find((b) => b.id === selectedBookId)
      if (book) {
        setBookName(book.name)
        setBookDescription(book.description)
        setBookFolder(book.folder || '')
      }
      setShowDiagnosticsModal(false)
    } else {
      setVectorSummary(null)
      setShowDiagnosticsModal(false)
    }
  }, [selectedBookId, books, loadVectorSummary])

  // Filtered, sorted, and paginated books
  const filteredSortedBooks = useMemo(() => {
    const q = searchFilter.trim().toLowerCase()
    const visible = q
      ? books.filter((b) => b.name.toLowerCase().includes(q))
      : [...books]

    return visible.sort((a, b) => {
      const comparison = sortBy === 'name'
        ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        : a.updated_at - b.updated_at
      return sortDir === 'asc' ? comparison : -comparison
    })
  }, [books, searchFilter, sortBy, sortDir])

  const totalBookPages = pageSize === 'all'
    ? 1
    : Math.max(1, Math.ceil(filteredSortedBooks.length / pageSize))
  const currentBookPage = Math.min(page, totalBookPages)
  const visibleBooks = useMemo(() => {
    if (pageSize === 'all') return filteredSortedBooks
    const start = (currentBookPage - 1) * pageSize
    return filteredSortedBooks.slice(start, start + pageSize)
  }, [filteredSortedBooks, currentBookPage, pageSize])
  const visibleBookIds = useMemo(() => visibleBooks.map((book) => book.id), [visibleBooks])
  const allVisibleBooksSelected = visibleBookIds.length > 0
    && visibleBookIds.every((id) => selectedIds.has(id))

  useEffect(() => {
    if (page > totalBookPages) setPage(totalBookPages)
  }, [page, totalBookPages])

  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current
      const bookIds = new Set(books.map((book) => book.id))
      let changed = false
      const next = new Set<string>()
      current.forEach((id) => {
        if (bookIds.has(id)) next.add(id)
        else changed = true
      })
      return changed ? next : current
    })
  }, [books])

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

  const handleSearchChange = useCallback((value: string) => {
    setSearchFilter(value)
    setPage(1)
  }, [])

  const handleSortByChange = useCallback((value: BookSortBy) => {
    setSortBy(value)
    setPage(1)
  }, [])

  const handleToggleSortDir = useCallback(() => {
    setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'))
    setPage(1)
  }, [])

  const handlePageSizeChange = useCallback((value: string) => {
    setPageSize(value === 'all' ? 'all' : Number(value) as BookPageSize)
    setPage(1)
  }, [])

  const handleToggleSelectMode = useCallback(() => {
    setSelectMode((current) => {
      if (current) setSelectedIds(new Set())
      return !current
    })
  }, [])

  const handleToggleBookSelection = useCallback((bookId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(bookId)) next.delete(bookId)
      else next.add(bookId)
      return next
    })
  }, [])

  const handleSelectAllVisible = useCallback(() => {
    setSelectedIds((current) => {
      const next = new Set(current)
      const deselectVisible = visibleBookIds.length > 0 && visibleBookIds.every((id) => current.has(id))
      for (const id of visibleBookIds) {
        if (deselectVisible) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }, [visibleBookIds])

  const handleBookRowActivate = useCallback((bookId: string) => {
    if (selectMode) {
      handleToggleBookSelection(bookId)
      return
    }
    setSelectedBookId(bookId)
  }, [handleToggleBookSelection, selectMode])

  const handleBookRowKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>, bookId: string) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    handleBookRowActivate(bookId)
  }, [handleBookRowActivate])

  const handleDownloadBook = useCallback(async (book: WorldBook) => {
    try {
      await worldBooksApi.downloadWorldBook(book.id, book.name)
    } catch {}
  }, [])

  const handleBulkDelete = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    setBulkActionPending(true)
    try {
      const result = await worldBooksApi.bulkDelete(ids)
      const deletedIds = new Set(result.deleted)
      setBooks((prev) => prev.filter((book) => !deletedIds.has(book.id)))
      setSelectedBookId((current) => (current && deletedIds.has(current) ? null : current))
      setSelectedIds(new Set())
      setBulkDeleteConfirm(null)
    } catch {
    } finally {
      setBulkActionPending(false)
    }
  }, [])

  const handleBulkExport = useCallback(async () => {
    if (!bulkExportIds || bulkExportIds.length === 0) return
    setBulkActionPending(true)
    try {
      const blob = await worldBooksApi.bulkExport(bulkExportIds, bulkExportFormat)
      triggerBlobDownload(blob, getBlobFilename(blob) || 'world-books.zip')
      setBulkExportIds(null)
    } catch {
    } finally {
      setBulkActionPending(false)
    }
  }, [bulkExportFormat, bulkExportIds])

  const handleBulkMoveFolder = useCallback(async (folder: string) => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0 || bulkActionPending) return
    const trimmed = folder.trim()
    const movedIds = new Set(ids)
    setBulkActionPending(true)
    if (selectedBookId && movedIds.has(selectedBookId)) markLocalBookEdit()
    try {
      await worldBooksApi.bulkMoveFolder(ids, trimmed)
      setBooks((prev) =>
        prev.map((book) => (movedIds.has(book.id) ? { ...book, folder: trimmed } : book))
      )
      setBookFolder((current) => (selectedBookId && movedIds.has(selectedBookId) ? trimmed : current))
      setSelectedIds(new Set())
    } catch {
    } finally {
      setBulkActionPending(false)
    }
  }, [bulkActionPending, markLocalBookEdit, selectedBookId, selectedIds])

  const handleBookNameChange = useCallback(
    (value: string) => {
      markLocalBookEdit()
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
    [selectedBookId, markLocalBookEdit]
  )

  const handleBookDescChange = useCallback(
    (value: string) => {
      markLocalBookEdit()
      setBookDescription(value)
      clearTimeout(bookDescTimer.current)
      bookDescTimer.current = setTimeout(() => {
        if (selectedBookId) {
          worldBooksApi.update(selectedBookId, { description: value })
        }
      }, 400)
    },
    [selectedBookId, markLocalBookEdit]
  )

  const handleBookFolderChange = useCallback(
    (value: string) => {
      markLocalBookEdit()
      const trimmed = value.trim()
      setBookFolder(trimmed)
      if (selectedBookId) {
        worldBooksApi.update(selectedBookId, { folder: trimmed })
        setBooks((prev) =>
          prev.map((b) => (b.id === selectedBookId ? { ...b, folder: trimmed } : b))
        )
      }
    },
    [selectedBookId, markLocalBookEdit]
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
      await loadVectorSummary(selectedBookId)
    } catch {
      setVectorStatus(t('reindexFailed'))
    } finally {
      setReindexing(false)
    }
  }, [selectedBookId, reindexing, loadVectorSummary, t])

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
      const reindexResult = await worldBooksApi.reindexVectors(selectedBookId, {
        onProgress: (p) => {
          setVectorStatus(t('reindexProgress', { status: formatWorldBookReindexStatus(p) }))
        },
      })
      const finalStatus = formatWorldBookReindexStatus(reindexResult)
      setVectorStatus(t('doneStatus', { status: finalStatus }))
      await loadVectorSummary(selectedBookId)
    } catch {
      setVectorStatus(t('convertFailed'))
    } finally {
      setReindexing(false)
    }
  }, [selectedBookId, loadVectorSummary, t])

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
              <div className={styles.sidebarSearchRow}>
                <input
                  type="text"
                  className={styles.searchInput}
                  placeholder={t('searchPlaceholder')}
                  value={searchFilter}
                  onChange={(e) => handleSearchChange(e.target.value)}
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
              <div className={styles.sidebarControlRow}>
                <select
                  className={styles.sidebarSelect}
                  value={sortBy}
                  onChange={(e) => handleSortByChange(e.target.value as BookSortBy)}
                  title={t('sortBy')}
                >
                  {BOOK_SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                  ))}
                </select>
                <select
                  className={clsx(styles.sidebarSelect, styles.sidebarPageSizeSelect)}
                  value={String(pageSize)}
                  onChange={(e) => handlePageSizeChange(e.target.value)}
                  title={t('pageSize')}
                >
                  {BOOK_PAGE_SIZE_OPTIONS.map((option) => (
                    <option key={String(option)} value={String(option)}>
                      {option === 'all' ? t('pageSizeAll') : t(`pageSize${option}`)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.sidebarIconBtn}
                  onClick={handleToggleSortDir}
                  title={sortDir === 'asc' ? t('sortAsc') : t('sortDesc')}
                  aria-label={sortDir === 'asc' ? t('sortAsc') : t('sortDesc')}
                >
                  {sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                  <ArrowUpDown size={9} />
                </button>
                <button
                  type="button"
                  className={clsx(styles.sidebarIconBtn, selectMode && styles.sidebarIconBtnActive)}
                  onClick={handleToggleSelectMode}
                  title={selectMode ? t('exitSelectMode') : t('selectMode')}
                  aria-label={selectMode ? t('exitSelectMode') : t('selectMode')}
                  aria-pressed={selectMode}
                >
                  {selectMode ? <CheckSquare size={13} /> : <Square size={13} />}
                </button>
              </div>
            </div>

            {selectMode && (
              <div className={styles.bulkBar}>
                <div className={styles.bulkSelectionRow}>
                  <button
                    type="button"
                    className={styles.bulkToggle}
                    onClick={handleSelectAllVisible}
                    disabled={visibleBookIds.length === 0}
                    title={allVisibleBooksSelected ? t('deselectVisible') : t('selectAllVisible')}
                    aria-label={allVisibleBooksSelected ? t('deselectVisible') : t('selectAllVisible')}
                  >
                    {allVisibleBooksSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                  </button>
                  <span className={styles.bulkCount}>{t('bulkSelected', { count: selectedIds.size })}</span>
                </div>
                {selectedIds.size > 0 && (
                  <div className={styles.bulkActions}>
                    <button
                      type="button"
                      className={clsx(styles.bulkActionBtn, styles.bulkDeleteBtn)}
                      onClick={() => setBulkDeleteConfirm(Array.from(selectedIds))}
                      disabled={bulkActionPending}
                    >
                      <Trash2 size={13} />
                      <span>{tc('actions.delete')}</span>
                    </button>
                    <button
                      type="button"
                      className={styles.bulkActionBtn}
                      onClick={() => {
                        setBulkExportFormat('lumiverse')
                        setBulkExportIds(Array.from(selectedIds))
                      }}
                      disabled={bulkActionPending}
                    >
                      <Download size={13} />
                      <span>{t('bulkExport')}</span>
                    </button>
                    <FolderDropdown
                      folders={folders}
                      selectedFolder=""
                      onSelect={(folder) => void handleBulkMoveFolder(folder)}
                      onCreateFolder={createFolder}
                      placeholder={t('bulkMoveFolder')}
                      className={styles.bulkFolderDropdown}
                    />
                  </div>
                )}
              </div>
            )}

            <div className={styles.bookList}>
              {visibleBooks.map((book) => {
                const selected = selectedIds.has(book.id)
                return (
                  <div
                    key={book.id}
                    role="button"
                    tabIndex={0}
                    className={clsx(
                      styles.bookItem,
                      selectedBookId === book.id && styles.bookItemActive,
                      selected && styles.bookItemSelected,
                    )}
                    onClick={() => handleBookRowActivate(book.id)}
                    onKeyDown={(e) => handleBookRowKeyDown(e, book.id)}
                    aria-pressed={selectMode ? selected : selectedBookId === book.id}
                  >
                    {selectMode && (
                      <input
                        type="checkbox"
                        className={styles.bookCheckbox}
                        checked={selected}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        onChange={() => handleToggleBookSelection(book.id)}
                        aria-label={selected ? t('deselectBook', { name: book.name }) : t('selectBook', { name: book.name })}
                      />
                    )}
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
                    <span className={styles.bookActions}>
                      <button
                        type="button"
                        className={styles.bookExportBtn}
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleDownloadBook(book)
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        title={t('exportBookTitle')}
                        aria-label={t('exportBookTitle')}
                      >
                        <Download size={11} />
                      </button>
                      <button
                        type="button"
                        className={styles.bookDeleteBtn}
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteBookConfirm(book.id)
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        title={t('deleteBookTitle')}
                        aria-label={t('deleteBookTitle')}
                      >
                        <Trash2 size={11} />
                      </button>
                    </span>
                  </div>
                )
              })}
              {filteredSortedBooks.length === 0 && (
                <div className={styles.emptyState}>{t('noBooksFound')}</div>
              )}
            </div>
            <Pagination
              className={styles.bookPagination}
              currentPage={currentBookPage}
              totalPages={totalBookPages}
              onPageChange={setPage}
              totalItems={filteredSortedBooks.length}
            />
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

      {/* Bulk delete confirmation */}
      {bulkDeleteConfirm && (
        <ConfirmationModal
          isOpen={true}
          title={t('bulkDeleteTitle')}
          message={t('bulkDeleteConfirmMessage', { count: bulkDeleteConfirm.length })}
          variant="danger"
          confirmText={tc('actions.delete')}
          loading={bulkActionPending}
          loadingText={t('bulkActionPending')}
          onConfirm={() => void handleBulkDelete(bulkDeleteConfirm)}
          onCancel={() => {
            if (!bulkActionPending) setBulkDeleteConfirm(null)
          }}
        />
      )}

      {/* Bulk export format picker */}
      {bulkExportIds && (
        <ModalShell
          isOpen={true}
          onClose={() => {
            if (!bulkActionPending) setBulkExportIds(null)
          }}
          maxWidth="420px"
          zIndex={10003}
        >
          <div className={styles.bulkDialogBody}>
            <h3 className={styles.bulkDialogTitle}>{t('bulkExportTitle')}</h3>
            <p className={styles.bulkDialogText}>
              {t('bulkExportMessage', { count: bulkExportIds.length })}
            </p>
            <div className={styles.exportFormatOptions}>
              {BOOK_EXPORT_FORMAT_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={clsx(
                    styles.exportFormatOption,
                    bulkExportFormat === option.value && styles.exportFormatOptionActive,
                  )}
                >
                  <input
                    type="radio"
                    name="world-book-bulk-export-format"
                    value={option.value}
                    checked={bulkExportFormat === option.value}
                    onChange={() => setBulkExportFormat(option.value)}
                    disabled={bulkActionPending}
                  />
                  <span>{t(option.labelKey)}</span>
                </label>
              ))}
            </div>
            <div className={styles.bulkDialogActions}>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => setBulkExportIds(null)}
                disabled={bulkActionPending}
              >
                {tc('actions.cancel')}
              </button>
              <button
                type="button"
                className={styles.primaryActionBtn}
                onClick={() => void handleBulkExport()}
                disabled={bulkActionPending}
              >
                {bulkActionPending ? t('bulkActionPending') : t('bulkExportConfirm')}
              </button>
            </div>
          </div>
        </ModalShell>
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
                    {(convertPreview.keys_retained ?? 0) > 0 && (
                      <li>{t('keysRetained', {
                        count: convertPreview.keys_retained ?? 0,
                        entryWord: convertPreview.keys_retained === 1 ? t('entry') : t('entries'),
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
