import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search, MessageSquare, Pencil, Download, Upload, Trash2,
  ArrowRight, Check, SortAsc, FileText, Clock, Plus, Gamepad2,
  ListChecks, X, Square, CheckSquare,
} from 'lucide-react'
import { strToU8, zipSync } from 'fflate'
import { useNavigate } from 'react-router'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { Spinner } from '@/components/shared/Spinner'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { chatsApi } from '@/api/chats'
import { get } from '@/api/client'
import { toast } from '@/lib/toast'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import clsx from 'clsx'
import { formatRelativeTime } from '@/lib/formatRelativeTime'
import { previewText } from '@/lib/previewText'
import { triggerBlobDownload } from '@/lib/downloads'
import styles from './ManageChatsModal.module.css'
import { clearSearchOnEscape } from '@/lib/clearableSearch'

interface ChatSummary {
  id: string
  name: string
  message_count: number
  created_at: number
  updated_at: number
  last_message_preview: string
  multiplayer?: boolean
}

type SortMode = 'date' | 'name' | 'messages'

const EMPTY_GROUP_CHARACTER_IDS: string[] = []

function sanitizeDownloadSegment(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  return sanitized || fallback
}

export default function ManageChatsModal() {
  const { t } = useTranslation('modals', { keyPrefix: 'manageChats' })
  const { t: tc } = useTranslation('common')

  const navigate = useNavigate()
  const closeModal = useStore((s) => s.closeModal)
  const characters = useStore((s) => s.characters)
  const modalProps = useStore((s) => s.modalProps) as {
    characterId: string
    characterName: string
    isGroupChat?: boolean
    groupCharacterIds?: string[]
  }
  const activeChatId = useStore((s) => s.activeChatId)

  const { characterId, characterName, isGroupChat = false, groupCharacterIds = EMPTY_GROUP_CHARACTER_IDS } = modalProps
  const isGroupContext = isGroupChat && groupCharacterIds.length > 1

  const [chats, setChats] = useState<ChatSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('date')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null)
  const [bulkDeleteTarget, setBulkDeleteTarget] = useState<{ ids: string[]; activeExcluded: boolean } | null>(null)
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [importingSt, setImportingSt] = useState(false)

  const renameInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const stFileInputRef = useRef<HTMLInputElement>(null)

  const formatChatName = useCallback((chat: ChatSummary) => {
    if (chat.name) return chat.name
    return t('unnamedChat', { date: new Date(chat.created_at * 1000).toLocaleString() })
  }, [t])

  const groupLabel = useMemo(() => {
    if (!isGroupContext) return null
    const names = groupCharacterIds
      .map((id) => characters.find((character) => character.id === id)?.name)
      .filter((name): name is string => Boolean(name))
    if (names.length === 0) return t('groupChatLabel', { count: groupCharacterIds.length })
    return `${names.join(', ')} · ${groupCharacterIds.length} members`
  }, [characters, groupCharacterIds, isGroupContext, t])

  // Fetch chats for this character or exact group composition.
  const fetchChats = useCallback(async () => {
    try {
      setLoading(true)
      const data = isGroupContext
        ? await chatsApi.listGroupChats({ characterIds: groupCharacterIds })
        : await get<ChatSummary[]>('/chats/character-chats/' + characterId)
      setChats(data)
    } catch (err) {
      console.error('[ManageChats] Failed to fetch chats:', err)
    } finally {
      setLoading(false)
    }
  }, [characterId, groupCharacterIds, isGroupContext])

  useEffect(() => {
    fetchChats()
  }, [fetchChats])

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  // Custom escape handler — cancel rename first, then close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (deleteTarget || bulkDeleteTarget) return
        if (renamingId) {
          setRenamingId(null)
          return
        }
        if (bulkMode) {
          setBulkMode(false)
          setSelectedIds(new Set())
          return
        }
        closeModal()
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [bulkDeleteTarget, bulkMode, closeModal, deleteTarget, renamingId])

  // Filter + sort
  const filteredChats = useMemo(() => {
    let list = chats
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((c) => formatChatName(c).toLowerCase().includes(q))
    }
    const sorted = [...list]
    switch (sortMode) {
      case 'date':
        sorted.sort((a, b) => b.updated_at - a.updated_at)
        break
      case 'name':
        sorted.sort((a, b) => formatChatName(a).localeCompare(formatChatName(b)))
        break
      case 'messages':
        sorted.sort((a, b) => b.message_count - a.message_count)
        break
    }
    return sorted
  }, [chats, search, sortMode, formatChatName])

  const filteredChatIds = useMemo(() => filteredChats.map((chat) => chat.id), [filteredChats])
  const selectedChats = useMemo(() => chats.filter((chat) => selectedIds.has(chat.id)), [chats, selectedIds])
  const allFilteredSelected = filteredChatIds.length > 0 && filteredChatIds.every((id) => selectedIds.has(id))
  const deletableSelectedIds = useMemo(
    () => selectedChats.filter((chat) => chat.id !== activeChatId).map((chat) => chat.id),
    [activeChatId, selectedChats],
  )

  useEffect(() => {
    const validIds = new Set(chats.map((chat) => chat.id))
    setSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => validIds.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [chats])

  const cycleSortMode = useCallback(() => {
    setSortMode((prev) => {
      if (prev === 'date') return 'name'
      if (prev === 'name') return 'messages'
      return 'date'
    })
  }, [])

  const sortLabel = sortMode === 'date' ? t('sortDate') : sortMode === 'name' ? t('sortName') : t('sortMessages')

  const toggleBulkMode = useCallback(() => {
    const nextEnabled = !bulkMode
    setBulkMode(nextEnabled)
    setSelectedIds(new Set())
    setRenamingId(null)
  }, [bulkMode])

  const toggleChatSelection = useCallback((chatId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(chatId)) next.delete(chatId)
      else next.add(chatId)
      return next
    })
  }, [])

  const toggleAllFiltered = useCallback(() => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (allFilteredSelected) filteredChatIds.forEach((id) => next.delete(id))
      else filteredChatIds.forEach((id) => next.add(id))
      return next
    })
  }, [allFilteredSelected, filteredChatIds])

  // Actions
  const handleSwitch = useCallback(
    (chatId: string) => {
      navigate('/chat/' + chatId)
      closeModal()
    },
    [navigate, closeModal]
  )

  const handleStartRename = useCallback((chat: ChatSummary) => {
    setRenamingId(chat.id)
    setRenameValue(chat.name || '')
  }, [])

  const handleConfirmRename = useCallback(
    async (chatId: string) => {
      const trimmed = renameValue.trim()
      if (!trimmed) {
        setRenamingId(null)
        return
      }
      try {
        await chatsApi.update(chatId, { name: trimmed })
        setChats((prev) =>
          prev.map((c) => (c.id === chatId ? { ...c, name: trimmed } : c))
        )
      } catch (err) {
        console.error('[ManageChats] Failed to rename chat:', err)
      }
      setRenamingId(null)
    },
    [renameValue]
  )

  const handleExport = useCallback(async (chatId: string, chatName: string) => {
    try {
      const data = await chatsApi.exportChat(chatId)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      triggerBlobDownload(blob, `${sanitizeDownloadSegment(chatName, 'chat')}_export.json`)
    } catch (err) {
      console.error('[ManageChats] Failed to export chat:', err)
    }
  }, [])

  const handleBulkExport = useCallback(async () => {
    if (selectedChats.length === 0) return
    setBulkBusy(true)
    try {
      const exportResults = await Promise.allSettled(selectedChats.map(async (chat, index) => ({
        chat,
        index,
        data: await chatsApi.exportChat(chat.id),
      })))
      const files: Record<string, Uint8Array> = {}
      let exportedCount = 0
      for (const result of exportResults) {
        if (result.status !== 'fulfilled') continue
        const item = result.value
        const displayName = formatChatName(item.chat)
        const baseName = sanitizeDownloadSegment(displayName, `chat-${item.index + 1}`)
        const idSuffix = item.chat.id.slice(0, 8)
        files[`${baseName}-${idSuffix}.json`] = strToU8(JSON.stringify(item.data, null, 2))
        exportedCount++
      }
      const failedCount = selectedChats.length - exportedCount
      if (exportedCount === 0) {
        toast.error(t('bulkExportFailed'))
        return
      }
      const archive = Uint8Array.from(zipSync(files, { level: 6 }))
      const contextName = sanitizeDownloadSegment(groupLabel || characterName, 'chats')
      triggerBlobDownload(new Blob([archive], { type: 'application/zip' }), `${contextName}-chats.zip`)
      if (failedCount > 0) {
        toast.warning(t('bulkExportPartial', { exported: exportedCount, failed: failedCount }))
      } else {
        toast.success(t('bulkExported', { count: exportedCount }))
      }
    } catch (err: any) {
      console.error('[ManageChats] Failed to export selected chats:', err)
      toast.error(err?.body?.error || err?.message || t('bulkExportFailed'))
    } finally {
      setBulkBusy(false)
    }
  }, [characterName, formatChatName, groupLabel, selectedChats, t])

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await chatsApi.delete(deleteTarget.id)
      setChats((prev) => prev.filter((c) => c.id !== deleteTarget.id))
    } catch (err) {
      console.error('[ManageChats] Failed to delete chat:', err)
    }
    setDeleteTarget(null)
  }, [deleteTarget])

  const handleConfirmBulkDelete = useCallback(async () => {
    if (!bulkDeleteTarget || bulkDeleteTarget.ids.length === 0) return
    const requestedIds = bulkDeleteTarget.ids
    setBulkDeleteTarget(null)
    setBulkBusy(true)
    try {
      const result = await chatsApi.bulkDeleteChats(requestedIds)
      const deletedIds = new Set(result.deleted)
      setChats((previous) => previous.filter((chat) => !deletedIds.has(chat.id)))
      setSelectedIds((previous) => {
        const next = new Set(previous)
        result.deleted.forEach((id) => next.delete(id))
        return next
      })
      if (result.deleted.length < requestedIds.length) {
        toast.warning(t('bulkDeletePartial', {
          deleted: result.deleted.length,
          failed: requestedIds.length - result.deleted.length,
        }))
      } else {
        toast.success(t('bulkDeleted', { count: result.deleted.length }))
      }
    } catch (err: any) {
      console.error('[ManageChats] Failed to delete selected chats:', err)
      toast.error(err?.body?.error || err?.message || t('bulkDeleteFailed'))
    } finally {
      setBulkBusy(false)
    }
  }, [bulkDeleteTarget, t])

  const handleNewChat = useCallback(async () => {
    const toastId = toast.info(t('startingChatMessage'), {
      title: t('startingChatTitle'),
      duration: 60_000,
      dismissible: false,
    })
    try {
      const chat = isGroupContext
        ? await chatsApi.createGroup({
            character_ids: groupCharacterIds,
            greeting_character_id: characterId,
          })
        : await chatsApi.create({ character_id: characterId })
      toast.dismiss(toastId)
      closeModal()
      navigate('/chat/' + chat.id)
    } catch (err) {
      toast.dismiss(toastId)
      console.error('[ManageChats] Failed to create chat:', err)
      toast.error(t('createFailed'))
    }
  }, [characterId, closeModal, groupCharacterIds, isGroupContext, navigate, t])

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      // Reset the input so re-selecting the same file triggers onChange
      e.target.value = ''

      setImporting(true)
      try {
        const text = await file.text()
        const data = JSON.parse(text)

        if (!data.chat || !data.messages) {
          toast.error(t('invalidExport'))
          return
        }

        await chatsApi.importChat(characterId, data)
        await fetchChats()
        toast.success(t('importSuccess'))
      } catch (err: any) {
        console.error('[ManageChats] Failed to import chat:', err)
        toast.error(err?.body?.error || err?.message || t('importFailed'))
      } finally {
        setImporting(false)
      }
    },
    [characterId, fetchChats, t]
  )

  const handleImportStClick = useCallback(() => {
    stFileInputRef.current?.click()
  }, [])

  const handleImportStFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      // Snapshot the FileList before clearing — setting input.value = '' mutates
      // the same FileList reference in Chromium, emptying it in place.
      const fileList = Array.from(e.target.files || [])
      e.target.value = ''
      if (fileList.length === 0) return

      setImportingSt(true)
      let imported = 0
      let speakerFallbackCount = 0
      const failures: { name: string; reason: string }[] = []
      for (const file of fileList) {
        try {
          if (isGroupContext) {
            const result = await chatsApi.importGroupFromSt(groupCharacterIds, file, characterId)
            speakerFallbackCount += result.speaker_name_fallback_count || 0
          } else {
            await chatsApi.importFromSt(characterId, file)
          }
          imported++
        } catch (err: any) {
          console.error('[ManageChats] Failed to import ST chat:', file.name, err)
          failures.push({ name: file.name, reason: err?.body?.error || err?.message || t('unknownError') })
        }
      }
      if (imported > 0) await fetchChats()
      const fallbackSuffix = isGroupContext && speakerFallbackCount > 0
        ? t('speakerFallback', { count: speakerFallbackCount })
        : ''
      if (imported > 0 && failures.length === 0) {
        if (fallbackSuffix) toast.warning(t('bulkImportedWithSuffix', { count: imported, suffix: fallbackSuffix }))
        else toast.success(t('bulkImported', { count: imported }))
      } else if (imported > 0 && failures.length > 0) {
        toast.warning(t('bulkImportPartial', {
          imported,
          failed: failures.length,
          name: failures[0].name,
          reason: failures[0].reason,
          suffix: fallbackSuffix,
        }).trim())
      } else if (failures.length === 1) {
        toast.error(t('bulkImportOneFailed', { name: failures[0].name, reason: failures[0].reason }))
      } else if (failures.length > 1) {
        toast.error(t('bulkImportManyFailed', { count: failures.length, reason: failures[0].reason }))
      }
      setImportingSt(false)
    },
    [characterId, fetchChats, groupCharacterIds, isGroupContext, t]
  )

  return (
    <>
    <ModalShell isOpen={true} onClose={closeModal} closeOnEscape={false} maxWidth="clamp(340px, 94vw, min(560px, var(--lumiverse-content-max-width, 560px)))" className={styles.modal}>
          <CloseButton onClick={closeModal} variant="solid" position="absolute" />

          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <h3 className={styles.title}>{t('title')}</h3>
              <span className={styles.subtitle}>
                {(groupLabel || characterName)} &middot; {t('chatCount', { count: chats.length })}
              </span>
            </div>
          </div>

          <div className={styles.toolbar}>
            <div className={styles.searchWrap}>
              <Search size={14} className={styles.searchIcon} />
              <input
                type="text"
                className={styles.searchInput}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => clearSearchOnEscape(e, search, () => setSearch(''))}
                placeholder={t('searchPlaceholder')}
              />
              {search && (
                <button type="button" className={styles.searchClear} onClick={() => setSearch('')} aria-label={tc('actions.clear')}>
                  <X size={13} />
                </button>
              )}
            </div>
            <Button size="sm" icon={<SortAsc size={13} />} onClick={cycleSortMode}>
              {sortLabel}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className={clsx(bulkMode && styles.bulkModeBtnActive)}
              onClick={toggleBulkMode}
              title={t(bulkMode ? 'exitBulkSelect' : 'bulkSelect')}
              aria-label={t(bulkMode ? 'exitBulkSelect' : 'bulkSelect')}
              icon={bulkMode ? <X size={14} /> : <ListChecks size={14} />}
            />
            <Button
              size="sm"
              icon={importing ? <Spinner size={13} /> : <Upload size={13} />}
              onClick={handleImportClick}
              disabled={importing}
              title={t('importJsonTitle')}
            >
              {t('import')}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
            <Button
              size="sm"
              icon={importingSt ? <Spinner size={13} /> : <Upload size={13} />}
              onClick={handleImportStClick}
              disabled={importingSt}
              title={isGroupContext ? t('importGroupJsonlTitle') : t('importJsonlTitle')}
            >
              {t('importSt')}
            </Button>
            <input
              ref={stFileInputRef}
              type="file"
              accept=".jsonl"
              multiple
              style={{ display: 'none' }}
              onChange={handleImportStFile}
            />
          </div>

          {bulkMode && (
            <div className={styles.bulkBar}>
              <div className={styles.bulkSummary}>
                <button
                  type="button"
                  className={styles.bulkSelectAll}
                  onClick={toggleAllFiltered}
                  disabled={filteredChatIds.length === 0 || bulkBusy}
                >
                  {allFilteredSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                  {t(allFilteredSelected ? 'deselectAll' : 'selectAll')}
                </button>
                <span className={styles.bulkCount}>{t('selectedCount', { count: selectedIds.size })}</span>
              </div>
              <div className={styles.bulkActions}>
                <button
                  type="button"
                  className={styles.bulkActionBtn}
                  onClick={() => { void handleBulkExport() }}
                  disabled={selectedIds.size === 0 || bulkBusy}
                  title={t('exportSelected')}
                >
                  {bulkBusy ? <Spinner size={13} /> : <Download size={13} />}
                  {t('export')}
                </button>
                <button
                  type="button"
                  className={clsx(styles.bulkActionBtn, styles.bulkDeleteBtn)}
                  onClick={() => {
                    if (deletableSelectedIds.length === 0) {
                      toast.info(t('activeChatDeleteHint'))
                      return
                    }
                    setBulkDeleteTarget({
                      ids: deletableSelectedIds,
                      activeExcluded: !!activeChatId && selectedIds.has(activeChatId),
                    })
                  }}
                  disabled={selectedIds.size === 0 || bulkBusy}
                  title={deletableSelectedIds.length === 0 && selectedIds.size > 0
                    ? t('activeChatDeleteHint')
                    : t('deleteSelected')}
                >
                  <Trash2 size={13} />
                  {t('delete')}
                </button>
              </div>
            </div>
          )}

          <div className={styles.body}>
            {loading && (
              <div className={styles.loading}>
                <Spinner size={16} />
                {t('loadingChats')}
              </div>
            )}

            {!loading && filteredChats.length === 0 && (
              <div className={styles.empty}>
                {search.trim() ? t('noMatch') : t('noChats')}
              </div>
            )}

            {!loading &&
              filteredChats.map((chat) => {
                const isActive = chat.id === activeChatId
                const displayName = formatChatName(chat)
                const selected = selectedIds.has(chat.id)
                return (
                  <div
                    key={chat.id}
                    className={clsx(
                      styles.card,
                      isActive && styles.cardActive,
                      bulkMode && styles.cardSelectable,
                      selected && styles.cardSelected,
                    )}
                    onClick={bulkMode ? () => toggleChatSelection(chat.id) : undefined}
                  >
                    {bulkMode ? (
                      <button
                        type="button"
                        className={styles.selectionBtn}
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleChatSelection(chat.id)
                        }}
                        aria-label={t(selected ? 'deselectChat' : 'selectChat', { name: displayName })}
                      >
                        {selected ? <CheckSquare size={18} /> : <Square size={18} />}
                      </button>
                    ) : (
                      <MessageSquare
                        size={18}
                        className={clsx(styles.cardIcon, isActive && styles.cardIconActive)}
                      />
                    )}

                    <div className={styles.cardInfo}>
                      {renamingId === chat.id ? (
                        <input
                          ref={renameInputRef}
                          type="text"
                          className={styles.editInput}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleConfirmRename(chat.id)
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          onBlur={() => handleConfirmRename(chat.id)}
                        />
                      ) : (
                        <span className={styles.cardName}>{displayName}</span>
                      )}
                      {chat.last_message_preview && (
                        <span className={styles.cardPreview}>
                          {previewText(chat.last_message_preview)}
                        </span>
                      )}
                      <div className={styles.cardMeta}>
                        <span className={styles.cardMetaItem}>
                          <FileText size={11} />
                          {chat.message_count}
                        </span>
                        <span className={styles.cardMetaItem}>
                          <Clock size={11} />
                          {formatRelativeTime(chat.updated_at)}
                        </span>
                        {chat.multiplayer && (
                          <span className={styles.cardMetaItem} style={{ color: 'var(--lumiverse-accent, #6366f1)', fontWeight: 600 }}>
                            <Gamepad2 size={11} />
                            Multiplayer
                          </span>
                        )}
                        {isActive && <span className={styles.activeBadge}>{t('active')}</span>}
                      </div>
                    </div>

                    {!bulkMode && <div className={styles.cardActions}>
                      {!isActive && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className={styles.actionBtnPrimary}
                          onClick={() => handleSwitch(chat.id)}
                          title={t('switchChat')}
                          icon={<ArrowRight size={14} />}
                        />
                      )}
                      {renamingId === chat.id ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className={styles.actionBtnPrimary}
                          onClick={() => handleConfirmRename(chat.id)}
                          title={t('confirmRename')}
                          icon={<Check size={14} />}
                        />
                      ) : (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleStartRename(chat)}
                          title={t('renameChat')}
                          icon={<Pencil size={14} />}
                        />
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleExport(chat.id, displayName)}
                        title={t('exportChat')}
                        icon={<Download size={14} />}
                      />
                      {!isActive && (
                        <Button
                          size="icon"
                          variant="danger-ghost"
                          onClick={() => setDeleteTarget(chat)}
                          title={t('deleteChat')}
                          icon={<Trash2 size={14} />}
                        />
                      )}
                    </div>}
                  </div>
                )
              })}

            {!bulkMode && (
              <button type="button" className={styles.newChatBtn} onClick={handleNewChat}>
                <Plus size={15} />
                {t('newChat')}
              </button>
            )}
          </div>
    </ModalShell>

      <ConfirmationModal
        isOpen={deleteTarget !== null}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
        title={t('deleteTitle')}
        message={t('deleteMessage', { name: deleteTarget ? formatChatName(deleteTarget) : '' })}
        variant="danger"
        confirmText={tc('actions.delete')}
        cancelText={tc('actions.cancel')}
      />

      <ConfirmationModal
        isOpen={bulkDeleteTarget !== null}
        onConfirm={handleConfirmBulkDelete}
        onCancel={() => setBulkDeleteTarget(null)}
        title={t('deleteSelectedTitle')}
        message={bulkDeleteTarget
          ? t(bulkDeleteTarget.activeExcluded ? 'deleteSelectedMessageActive' : 'deleteSelectedMessage', {
              count: bulkDeleteTarget.ids.length,
            })
          : ''}
        variant="danger"
        confirmText={tc('actions.delete')}
        cancelText={tc('actions.cancel')}
      />
    </>
  )
}
