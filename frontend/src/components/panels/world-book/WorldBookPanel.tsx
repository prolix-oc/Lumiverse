import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { Plus, Trash2, BookOpen, Maximize2, ChevronDown, Upload, Download, Globe, X, User, FileUp, Settings, Search, MessageSquare, ArrowDownAZ, ArrowDownZA } from 'lucide-react'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import { worldBooksApi } from '@/api/world-books'
import { chatsApi } from '@/api/chats'
import WorldBookEntriesSection from '@/components/shared/WorldBookEntriesSection'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import ImportWorldBookModal, { type WorldBookImportResult } from '@/components/modals/ImportWorldBookModal'
import PostImportWorldBookModal from '@/components/shared/PostImportWorldBookModal'
import NumericInput from '@/components/shared/NumericInput'
import WorldBookDiagnosticsModal from '@/components/panels/world-book/WorldBookDiagnosticsModal'
import { formatWorldBookReindexStatus } from '@/lib/worldBookVectorization'
import { filterWorldBooksForChatContextAttachment } from '@/lib/worldBookIndexPrompt'
import { Button } from '@/components/shared/FormComponents'
import SearchableSelect from '@/components/shared/SearchableSelect'
import FolderDropdown from '@/components/shared/FolderDropdown'
import { useFolders } from '@/hooks/useFolders'
import { useWorldBookListLiveSync } from '@/hooks/useWorldBookListLiveSync'
import type { WorldBook, WorldBookVectorSummary, WorldInfoSettings } from '@/types/api'

import styles from './WorldBookPanel.module.css'
import clsx from 'clsx'

export default function WorldBookPanel() {
  const { t } = useTranslation('panels')
  const openModal = useStore((s) => s.openModal)
  const isMobile = useIsMobile()
  const activeChatId = useStore((s) => s.activeChatId)
  const globalWorldBooks = useStore((s) => s.globalWorldBooks)
  const worldInfoSettings = useStore((s) => s.worldInfoSettings)
  const worldBookListSortDir = useStore((s) => s.worldBookListSortDir)
  const setSetting = useStore((s) => s.setSetting)
  const [wiSettingsOpen, setWiSettingsOpen] = useState(false)

  // Book list state
  const [books, setBooks] = useState<WorldBook[]>([])
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null)

  // Cross-component navigation: other panels (e.g. the character editor) can
  // request a book be opened here via the store before switching to this tab.
  const pendingWorldBookEditId = useStore((s) => s.pendingWorldBookEditId)
  const setPendingWorldBookEditId = useStore((s) => s.setPendingWorldBookEditId)
  useEffect(() => {
    if (!pendingWorldBookEditId) return
    setSelectedBookId(pendingWorldBookEditId)
    setPendingWorldBookEditId(null)
  }, [pendingWorldBookEditId, setPendingWorldBookEditId])
  // Books are presented alphabetically (case-insensitive) in every selector;
  // the backend returns them in updated_at order which made navigation tedious
  // once there were more than a handful.
  const sortedBooks = useMemo(() => {
    const dir = worldBookListSortDir === 'desc' ? -1 : 1
    return [...books].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * dir)
  }, [books, worldBookListSortDir])
  const toggleBookListSortDir = useCallback(() => {
    setSetting('worldBookListSortDir', worldBookListSortDir === 'asc' ? 'desc' : 'asc')
  }, [setSetting, worldBookListSortDir])

  // Book editing state
  const [bookFieldsOpen, setBookFieldsOpen] = useState(false)
  const [bookName, setBookName] = useState('')
  const [bookDescription, setBookDescription] = useState('')
  const [bookFolder, setBookFolder] = useState('')
  const { folders, createFolder } = useFolders('worldBookFolders', books)
  const [vectorStatus, setVectorStatus] = useState<string | null>(null)
  const [vectorSummary, setVectorSummary] = useState<WorldBookVectorSummary | null>(null)
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false)

  const [postImportBook, setPostImportBook] = useState<WorldBook | null>(null)

  // Confirmation modals
  const [deleteBookConfirm, setDeleteBookConfirm] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [convertPreview, setConvertPreview] = useState<{
    total: number; eligible: number; keys_to_clear: number; keys_retained: number; constant_skipped: number
    already_vectorized: number; empty_skipped: number; disabled_skipped: number
  } | null>(null)

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
  })

  const loadVectorSummary = useCallback(async (bookId: string) => {
    try {
      const summary = await worldBooksApi.getVectorSummary(bookId)
      setVectorSummary(summary)
    } catch {
      setVectorSummary(null)
    }
  }, [])

  // Side effects on book selection change (book fields, vector summary, reset UI state)
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

  // Book CRUD
  const handleCreateBook = useCallback(async () => {
    try {
      const book = await worldBooksApi.create({ name: t('worldBookPanel.defaultBookName') })
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
      }, 2000)
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
      }, 2000)
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

  const [reindexing, setReindexing] = useState(false)

  const handleReindexVectors = useCallback(async () => {
    if (!selectedBookId || reindexing) return
    try {
      setReindexing(true)
      setVectorStatus(t('worldBookPanel.reindexingVectors'))
      const result = await worldBooksApi.reindexVectors(selectedBookId, {
        onProgress: (p) => {
          setVectorStatus(t('worldBookPanel.reindexProgress', { status: formatWorldBookReindexStatus(p) }))
        },
      })
      const finalStatus = formatWorldBookReindexStatus(result)
      setVectorStatus(t('worldBookPanel.doneStatus', { status: finalStatus }))
      await loadVectorSummary(selectedBookId)
    } catch {
      setVectorStatus(t('worldBookPanel.vectorReindexFailed'))
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
      setVectorStatus(t('worldBookPanel.vectorPreviewFailed'))
    }
  }, [selectedBookId])

  const handleConvertToVectorized = useCallback(async () => {
    if (!selectedBookId) return
    setConvertPreview(null)
    try {
      setReindexing(true)
      const result = await worldBooksApi.convertToVectorized(selectedBookId)
      setVectorSummary(result.summary)
      setVectorStatus(t('worldBookPanel.convertedReindexing', { count: result.converted }))
      const reindexResult = await worldBooksApi.reindexVectors(selectedBookId, {
        onProgress: (p) => {
          setVectorStatus(t('worldBookPanel.reindexProgress', { status: formatWorldBookReindexStatus(p) }))
        },
      })
      const finalStatus = formatWorldBookReindexStatus(reindexResult)
      setVectorStatus(t('worldBookPanel.doneStatus', { status: finalStatus }))
      await loadVectorSummary(selectedBookId)
    } catch {
      setVectorStatus(t('worldBookPanel.vectorConvertFailed'))
    } finally {
      setReindexing(false)
    }
  }, [selectedBookId, loadVectorSummary, t])

  const handleDiagnostics = useCallback(async () => {
    if (!selectedBookId || !activeChatId) return
    setShowDiagnosticsModal(true)
  }, [selectedBookId, activeChatId])

  const handleImport = useCallback((result: WorldBookImportResult) => {
    setBooks((prev) => [result.world_book, ...prev])
    setSelectedBookId(result.world_book.id)
    setShowImport(false)
    setPostImportBook(result.world_book)
  }, [])

  const handlePopOut = useCallback(() => {
    openModal('worldBookEditor', { bookId: selectedBookId })
  }, [openModal, selectedBookId])

  const setGlobalBooks = useCallback(
    async (ids: string[]) => {
      const currentIds = globalWorldBooks ?? []
      if (!activeChatId) {
        setSetting('globalWorldBooks', ids)
        return
      }

      const allowedAddedIds = await filterWorldBooksForChatContextAttachment(
        books.filter((book) => ids.includes(book.id) && !currentIds.includes(book.id)),
      )
      setSetting(
        'globalWorldBooks',
        ids.filter((id) => currentIds.includes(id) || allowedAddedIds.includes(id)),
      )
    },
    [activeChatId, books, globalWorldBooks, setSetting],
  )

  const removeGlobalBook = (id: string) => {
    setSetting('globalWorldBooks', (globalWorldBooks ?? []).filter((x) => x !== id))
  }

  const activeGlobalBooks = books.filter((b) => (globalWorldBooks ?? []).includes(b.id))
  const selectedBook = books.find((book) => book.id === selectedBookId) ?? null

  // Chat-scoped world books
  const [chatWorldBookIds, setChatWorldBookIds] = useState<string[]>([])
  const [chatMetadata, setChatMetadata] = useState<Record<string, any>>({})

  useEffect(() => {
    if (!activeChatId) {
      setChatWorldBookIds([])
      setChatMetadata({})
      return
    }
    chatsApi.get(activeChatId).then((chat) => {
      const meta = (chat as any).metadata || {}
      setChatMetadata(meta)
      setChatWorldBookIds((meta.chat_world_book_ids as string[]) ?? [])
    }).catch(() => {})
  }, [activeChatId])

  // Atomic partial merge so concurrent server-side writers (post-generation
  // expression detection, council caching, etc.) can't clobber this change.
  const setChatBooks = useCallback(
    (next: string[]) => {
      setChatWorldBookIds(next)
      setChatMetadata((prev) => ({ ...prev, chat_world_book_ids: next }))
      if (activeChatId) chatsApi.patchMetadata(activeChatId, { chat_world_book_ids: next }).catch(() => {})
    },
    [activeChatId],
  )

  const handleChatBooksChange = useCallback(
    async (next: string[]) => {
      const allowedAddedIds = await filterWorldBooksForChatContextAttachment(
        books.filter((book) => next.includes(book.id) && !chatWorldBookIds.includes(book.id)),
      )
      setChatBooks(next.filter((id) => chatWorldBookIds.includes(id) || allowedAddedIds.includes(id)))
    },
    [books, chatWorldBookIds, setChatBooks],
  )

  const removeChatBook = (id: string) => {
    setChatBooks(chatWorldBookIds.filter((x) => x !== id))
  }

  const activeChatBooks = books.filter((b) => chatWorldBookIds.includes(b.id))

  // Export popover
  const [exportPopoverOpen, setExportPopoverOpen] = useState(false)
  const exportBtnRef = useRef<HTMLDivElement>(null)
  const exportPopoverRef = useRef<HTMLDivElement>(null)
  const [exportPopoverPos, setExportPopoverPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!exportPopoverOpen) return
    const handleClick = (e: MouseEvent) => {
      if (
        exportPopoverRef.current && !exportPopoverRef.current.contains(e.target as Node) &&
        exportBtnRef.current && !exportBtnRef.current.contains(e.target as Node)
      ) {
        setExportPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [exportPopoverOpen])

  const openExportPopover = useCallback(() => {
    setExportPopoverOpen((prev) => {
      const next = !prev
      if (next && exportBtnRef.current) {
        const rect = exportBtnRef.current.getBoundingClientRect()
        // Portaled popover lives inside `body > *` (CSS zoom: --lumiverse-ui-scale);
        // rect is post-zoom but inline top/left are interpreted pre-zoom, so divide
        // by the scale so the popover anchors to the button at any UI scale.
        const uiScale = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale'),
        ) || 1
        setExportPopoverPos({ top: (rect.bottom + 4) / uiScale, left: rect.right / uiScale })
      }
      return next
    })
  }, [])

  const handleExport = useCallback(async (format: 'lumiverse' | 'character_book' | 'sillytavern') => {
    if (!selectedBookId) return
    setExportPopoverOpen(false)
    try {
      const data = await worldBooksApi.export(selectedBookId, format)
      const safeName = (bookName || 'world-book').replace(/[^a-zA-Z0-9_-]/g, '_')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${safeName}_${format}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      console.error('Export failed:', err)
    }
  }, [selectedBookId, bookName])

  return (
    <div className={styles.panel}>
      {/* Global world books section */}
      <div className={styles.globalSection}>
        <div className={styles.globalHeader}>
          <Globe size={12} className={styles.globalIcon} />
          <span className={styles.globalLabel}>{t('worldBookPanel.alwaysActive')}</span>
          <SearchableSelect
            multi
            value={globalWorldBooks ?? []}
            onChange={(ids) => { void setGlobalBooks(ids) }}
            options={sortedBooks.map((b) => ({ value: b.id, label: b.name, group: b.folder || undefined }))}
            triggerLabel={t('worldBookPanel.add')}
            triggerIcon={<Plus size={11} />}
            searchPlaceholder={t('worldBookPanel.searchWorldBooks')}
            emptyMessage={t('worldBookPanel.noWorldBooksAvailable')}
            className={styles.bookPickerSelect}
            portal
            align="right"
            minWidth={280}
          />
        </div>
        {activeGlobalBooks.length > 0 ? (
          <div className={styles.globalPills}>
            {activeGlobalBooks.map((book) => (
              <span key={book.id} className={styles.globalPill}>
                <button
                  type="button"
                  className={styles.globalPillName}
                  onClick={() => setSelectedBookId(book.id)}
                  title={t('worldBookPanel.editBook')}
                >
                  {book.name}
                </button>
                <button
                  type="button"
                  className={styles.globalPillRemove}
                  onClick={() => removeGlobalBook(book.id)}
                  title={t('worldBookPanel.removeFromAlwaysActive')}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <span className={styles.globalHint}>{t('worldBookPanel.noGlobalActive')}</span>
        )}
      </div>

      {/* Chat-scoped world books section */}
      <div className={clsx(styles.chatSection, !activeChatId && styles.chatSectionDisabled)}>
        <div className={styles.chatHeader}>
          <MessageSquare size={12} className={styles.chatIcon} />
          <span className={styles.chatLabel}>{t('worldBookPanel.thisChatOnly')}</span>
          {activeChatId ? (
            <SearchableSelect
              multi
              value={chatWorldBookIds}
              onChange={(ids) => { void handleChatBooksChange(ids) }}
              options={sortedBooks.map((b) => ({ value: b.id, label: b.name, group: b.folder || undefined }))}
              triggerLabel={t('worldBookPanel.add')}
              triggerIcon={<Plus size={11} />}
              searchPlaceholder={t('worldBookPanel.searchWorldBooks')}
              emptyMessage={t('worldBookPanel.noWorldBooksAvailable')}
              className={styles.bookPickerSelect}
              portal
              align="right"
              minWidth={280}
            />
          ) : null}
        </div>
        {!activeChatId ? (
          <span className={styles.chatHint}>{t('worldBookPanel.openChatToAdd')}</span>
        ) : activeChatBooks.length > 0 ? (
          <div className={styles.chatPills}>
            {activeChatBooks.map((book) => (
              <span key={book.id} className={styles.chatPill}>
                <button
                  type="button"
                  className={styles.chatPillName}
                  onClick={() => setSelectedBookId(book.id)}
                  title={t('worldBookPanel.editBook')}
                >
                  {book.name}
                </button>
                <button
                  type="button"
                  className={styles.chatPillRemove}
                  onClick={() => removeChatBook(book.id)}
                  title={t('worldBookPanel.removeFromChat')}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <span className={styles.chatHint}>{t('worldBookPanel.noChatActive')}</span>
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
          <span>{t('worldBookPanel.activationSettings')}</span>
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
        <SearchableSelect
          value={selectedBookId || ''}
          onChange={(v) => setSelectedBookId(v || null)}
          options={sortedBooks.map((b) => ({ value: b.id, label: b.name, group: b.folder || undefined }))}
          placeholder={t('worldBookPanel.selectBook')}
          searchPlaceholder={t('worldBookPanel.searchWorldBooks')}
          emptyMessage={t('worldBookPanel.noWorldBooksAvailable')}
          ariaLabel={t('worldBookPanel.selectWorldBookAria')}
          className={styles.bookSelectWrapper}
          clearable
          clearLabel={t('worldBookPanel.none')}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={toggleBookListSortDir}
          title={worldBookListSortDir === 'asc' ? t('worldBookPanel.sortedAsc') : t('worldBookPanel.sortedDesc')}
          icon={worldBookListSortDir === 'asc' ? <ArrowDownAZ size={14} /> : <ArrowDownZA size={14} />}
        />
        {(() => {
          const sel = books.find((b) => b.id === selectedBookId)
          if (sel?.metadata?.source === 'character') return (
            <span className={styles.sourceBadge} data-tooltip={t('worldBookPanel.fromCharacter')}>
              <User size={11} />
            </span>
          )
          if (sel?.metadata?.source === 'import') return (
            <span className={styles.sourceBadge} data-tooltip={t('worldBookPanel.importedFromFile')}>
              <FileUp size={11} />
            </span>
          )
          return null
        })()}
        <Button size="icon-sm" variant="ghost" onClick={handleCreateBook} title={t('worldBookPanel.newBook')} icon={<Plus size={14} />} />
        <Button size="icon-sm" variant="ghost" onClick={() => setShowImport(true)} title={t('worldBookPanel.importBook')} icon={<Download size={14} />} />
        {selectedBookId && (
          <div className={styles.exportWrapper} ref={exportBtnRef}>
            <Button size="icon-sm" variant="ghost" onClick={openExportPopover} title={t('worldBookPanel.exportBook')} icon={<Upload size={14} />} />
            {exportPopoverOpen && exportPopoverPos && createPortal(
              <div
                ref={exportPopoverRef}
                className={styles.exportPopover}
                style={{ top: exportPopoverPos.top, left: exportPopoverPos.left }}
              >
                <button type="button" className={styles.exportPopoverItem} onClick={() => handleExport('lumiverse')}>
                  {t('worldBookPanel.exportLumiverse')}
                </button>
                <button type="button" className={styles.exportPopoverItem} onClick={() => handleExport('character_book')}>
                  {t('worldBookPanel.exportCharacterBook')}
                </button>
                <button type="button" className={styles.exportPopoverItem} onClick={() => handleExport('sillytavern')}>
                  {t('worldBookPanel.exportSillyTavern')}
                </button>
              </div>,
              document.body
            )}
          </div>
        )}
        {!isMobile && (
          <Button size="icon-sm" variant="ghost" onClick={handlePopOut} title={t('worldBookPanel.popOut')} icon={<Maximize2 size={14} />} />
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
            <span className={styles.bookFieldsLabel}>{bookName || t('worldBookPanel.bookDetails')}</span>
            <ChevronDown
              size={12}
              className={clsx(styles.chevron, bookFieldsOpen && styles.chevronOpen)}
            />
          </button>

          {bookFieldsOpen && (
            <div className={styles.bookFields}>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>{t('worldBookPanel.name')}</label>
                <input
                  type="text"
                  className={styles.fieldInput}
                  value={bookName}
                  onChange={(e) => handleBookNameChange(e.target.value)}
                />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>{t('worldBookPanel.description')}</label>
                <input
                  type="text"
                  className={styles.fieldInput}
                  value={bookDescription}
                  onChange={(e) => handleBookDescChange(e.target.value)}
                  placeholder={t('worldBookPanel.optionalDescription')}
                />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>{t('worldBookPanel.folder')}</label>
                <FolderDropdown
                  folders={folders}
                  selectedFolder={bookFolder}
                  onSelect={handleBookFolderChange}
                  onCreateFolder={createFolder}
                />
              </div>
              <Button variant="danger-ghost" size="sm" icon={<Trash2 size={11} />} onClick={() => setDeleteBookConfirm(selectedBookId)}>
                {t('worldBookPanel.deleteBook')}
              </Button>
              {vectorSummary && (
                <div className={styles.vectorSummary}>
                  <div className={styles.vectorSummaryTitle}>{t('worldBookPanel.vectorStatusTitle')}</div>
                  <div className={styles.vectorSummaryGrid}>
                    <span>{t('worldBookPanel.vectorEnabled', { count: vectorSummary.enabled })}</span>
                    <span>{t('worldBookPanel.vectorNonEmpty', { enabled: vectorSummary.enabled_non_empty, total: vectorSummary.non_empty })}</span>
                    <span>{t('worldBookPanel.vectorIndexed', { count: vectorSummary.indexed })}</span>
                    <span>{t('worldBookPanel.vectorPending', { count: vectorSummary.pending })}</span>
                    <span>{t('worldBookPanel.vectorErrors', { count: vectorSummary.error })}</span>
                  </div>
                </div>
              )}
              <div className={styles.bookActionRow}>
                <Button variant="primary" size="sm" onClick={handleReindexVectors} disabled={reindexing}>
                  {reindexing ? t('worldBookPanel.reindexing') : t('worldBookPanel.reindexVectorSearch')}
                </Button>
                <Button variant="secondary" size="sm" onClick={handleConvertToVectorizedPreview} disabled={reindexing}>
                  {t('worldBookPanel.convertToVectorized')}
                </Button>
                <Button variant="secondary" size="sm" icon={<Search size={12} />} onClick={handleDiagnostics} disabled={!activeChatId}>
                  {t('worldBookPanel.diagnoseCurrentChat')}
                </Button>
              </div>
              {vectorStatus && <span className={styles.vectorStatusText}>{vectorStatus}</span>}
            </div>
          )}

          <WorldBookEntriesSection
            books={books}
            selectedBookId={selectedBookId}
            onRefreshVectorSummary={loadVectorSummary}
          />

        </>
      ) : (
        <div className={styles.emptyState}>
          {t('worldBookPanel.selectOrCreate')}
        </div>
      )}

      {/* Delete book confirmation */}
      {deleteBookConfirm && (
        <ConfirmationModal
          isOpen={true}
          title={t('worldBookPanel.deleteWorldBookTitle')}
          message={t('worldBookPanel.deleteWorldBookMessage')}
          variant="danger"
          confirmText={t('worldBookPanel.delete')}
          onConfirm={async () => {
            await handleDeleteBook(deleteBookConfirm)
            setDeleteBookConfirm(null)
          }}
          onCancel={() => setDeleteBookConfirm(null)}
        />
      )}

      {/* Convert to vectorized confirmation */}
      {convertPreview && (
        <ConfirmationModal
          isOpen={true}
          title={t('worldBookPanel.convertToVectorizedTitle')}
          message={
            convertPreview.eligible === 0
              ? t('worldBookPanel.convertNoneEligible')
              : <>
                  <p>{t('worldBookPanel.convertIntro', { count: convertPreview.eligible })}</p>
                  <ul style={{ textAlign: 'left', margin: '8px 0', paddingLeft: '20px', fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))', opacity: 0.8 }}>
                    {convertPreview.keys_retained > 0 && <li>{t('worldBookPanel.convertKeysRetained', { count: convertPreview.keys_retained })}</li>}
                    {convertPreview.constant_skipped > 0 && <li>{t('worldBookPanel.convertConstantSkipped', { count: convertPreview.constant_skipped })}</li>}
                    {convertPreview.already_vectorized > 0 && <li>{t('worldBookPanel.convertAlreadyVectorized', { count: convertPreview.already_vectorized })}</li>}
                    {convertPreview.empty_skipped > 0 && <li>{t('worldBookPanel.convertEmptySkipped', { count: convertPreview.empty_skipped })}</li>}
                    {convertPreview.disabled_skipped > 0 && <li>{t('worldBookPanel.convertDisabledSkipped', { count: convertPreview.disabled_skipped })}</li>}
                  </ul>
                </>
          }
          variant="safe"
          confirmText={convertPreview.eligible > 0 ? t('worldBookPanel.convertAndReindex') : t('worldBookPanel.ok')}
          onConfirm={convertPreview.eligible > 0 ? handleConvertToVectorized : () => setConvertPreview(null)}
          onCancel={() => setConvertPreview(null)}
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
  const { t } = useTranslation('panels')
  const globalScanDepth = settings.globalScanDepth && settings.globalScanDepth > 0 ? settings.globalScanDepth : null
  const maxRecursionPasses = Number.isFinite(settings.maxRecursionPasses) ? Math.max(0, Math.floor(settings.maxRecursionPasses)) : 3
  const maxActivatedEntries = Number.isFinite(settings.maxActivatedEntries) ? Math.max(0, Math.floor(settings.maxActivatedEntries)) : 0
  const maxTokenBudget = Number.isFinite(settings.maxTokenBudget) ? Math.max(0, Math.floor(settings.maxTokenBudget)) : 0
  const minPriority = Number.isFinite(settings.minPriority) ? Math.max(0, Math.floor(settings.minPriority)) : 0

  return (
    <div className={styles.wiSettingsBody}>
      <div className={styles.wiField}>
        <label className={styles.wiFieldLabel}>{t('worldBookPanel.globalScanDepth')}</label>
        <p className={styles.wiFieldHint}>
          {t('worldBookPanel.globalScanDepthHint')}
        </p>
        <div className={styles.wiFieldRow}>
          <NumericInput
            className={styles.wiFieldInput}
            min={0}
            max={200}
            placeholder={t('worldBookPanel.unlimited')}
            value={globalScanDepth}
            integer
            allowEmpty
            onChange={(value) => {
              onChange({ globalScanDepth: value == null || value <= 0 ? null : Math.floor(value) })
            }}
          />
          {globalScanDepth != null && (
            <button type="button" className={styles.wiFieldClear} onClick={() => onChange({ globalScanDepth: null })}>
              <X size={10} />
            </button>
          )}
        </div>
      </div>

      <div className={styles.wiField}>
        <label className={styles.wiFieldLabel}>{t('worldBookPanel.maxRecursionPasses')}</label>
        <p className={styles.wiFieldHint}>
          {t('worldBookPanel.maxRecursionPassesHint')}
        </p>
        <div className={styles.wiFieldRow}>
          <input
            type="range"
            className={styles.wiRange}
            min={0}
            max={10}
            value={maxRecursionPasses}
            onChange={(e) => onChange({ maxRecursionPasses: Math.max(0, parseInt(e.target.value, 10) || 0) })}
          />
          <span className={styles.wiRangeValue}>{maxRecursionPasses}</span>
        </div>
      </div>

      <div className={styles.wiField}>
        <label className={styles.wiFieldLabel}>{t('worldBookPanel.maxActivatedEntries')}</label>
        <p className={styles.wiFieldHint}>
          {t('worldBookPanel.maxActivatedEntriesHint')}
        </p>
        <NumericInput
          className={styles.wiFieldInput}
          min={0}
          max={500}
          placeholder={t('worldBookPanel.unlimited')}
          value={maxActivatedEntries || null}
          integer
          onChange={(value) => onChange({ maxActivatedEntries: Math.max(0, Math.floor(value ?? 0)) })}
        />
      </div>

      <div className={styles.wiField}>
        <label className={styles.wiFieldLabel}>{t('worldBookPanel.maxTokenBudget')}</label>
        <p className={styles.wiFieldHint}>
          {t('worldBookPanel.maxTokenBudgetHint')}
        </p>
        <NumericInput
          className={styles.wiFieldInput}
          min={0}
          max={50000}
          step={100}
          placeholder={t('worldBookPanel.unlimited')}
          value={maxTokenBudget || null}
          integer
          onChange={(value) => onChange({ maxTokenBudget: Math.max(0, Math.floor(value ?? 0)) })}
        />
      </div>

      <div className={styles.wiField}>
        <label className={styles.wiFieldLabel}>{t('worldBookPanel.minPriorityThreshold')}</label>
        <p className={styles.wiFieldHint}>
          {t('worldBookPanel.minPriorityThresholdHint')}
        </p>
        <div className={styles.wiFieldRow}>
          <input
            type="range"
            className={styles.wiRange}
            min={0}
            max={100}
            value={minPriority}
            onChange={(e) => onChange({ minPriority: Math.max(0, parseInt(e.target.value, 10) || 0) })}
          />
          <span className={styles.wiRangeValue}>{minPriority}</span>
        </div>
      </div>
    </div>
  )
}
