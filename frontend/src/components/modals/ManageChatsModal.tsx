import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Search, MessageSquare, Pencil, Download, Upload, Trash2,
  ArrowRight, Check, SortAsc, FileText, Clock, Plus,
} from 'lucide-react'
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
import styles from './ManageChatsModal.module.css'

interface ChatSummary {
  id: string
  name: string
  message_count: number
  created_at: number
  updated_at: number
}

type SortMode = 'date' | 'name' | 'messages'

const EMPTY_GROUP_CHARACTER_IDS: string[] = []

function formatRelativeTime(epochSeconds: number): string {
  const now = Date.now()
  const diff = now - epochSeconds * 1000
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(epochSeconds * 1000).toLocaleDateString()
}

function formatChatName(chat: ChatSummary): string {
  if (chat.name) return chat.name
  return `Chat ${new Date(chat.created_at * 1000).toLocaleString()}`
}

export default function ManageChatsModal() {
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
  const [importing, setImporting] = useState(false)
  const [importingSt, setImportingSt] = useState(false)

  const renameInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const stFileInputRef = useRef<HTMLInputElement>(null)

  const groupLabel = useMemo(() => {
    if (!isGroupContext) return null
    const names = groupCharacterIds
      .map((id) => characters.find((character) => character.id === id)?.name)
      .filter((name): name is string => Boolean(name))
    if (names.length === 0) return `Group Chat · ${groupCharacterIds.length} members`
    return `${names.join(', ')} · ${groupCharacterIds.length} members`
  }, [characters, groupCharacterIds, isGroupContext])

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
        if (renamingId) {
          setRenamingId(null)
          return
        }
        closeModal()
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [closeModal, renamingId])

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
  }, [chats, search, sortMode])

  const cycleSortMode = useCallback(() => {
    setSortMode((prev) => {
      if (prev === 'date') return 'name'
      if (prev === 'name') return 'messages'
      return 'date'
    })
  }, [])

  const sortLabel = sortMode === 'date' ? 'Date' : sortMode === 'name' ? 'Name' : 'Messages'

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
      const data = await get<{ chat: any; messages: any[] }>('/chats/' + chatId + '/export')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${chatName || 'chat'}_export.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('[ManageChats] Failed to export chat:', err)
    }
  }, [])

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

  const handleNewChat = useCallback(async () => {
    const toastId = toast.info('Creating chat and preparing Memory Cortex in the background…', {
      title: 'Starting Chat',
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
      toast.error('Failed to create chat')
    }
  }, [characterId, closeModal, groupCharacterIds, isGroupContext, navigate])

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
          toast.error('Invalid chat export format')
          return
        }

        await chatsApi.importChat(characterId, data)
        await fetchChats()
        toast.success('Chat imported')
      } catch (err: any) {
        console.error('[ManageChats] Failed to import chat:', err)
        toast.error(err?.body?.error || err?.message || 'Failed to import chat')
      } finally {
        setImporting(false)
      }
    },
    [characterId, fetchChats]
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
          failures.push({ name: file.name, reason: err?.body?.error || err?.message || 'Unknown error' })
        }
      }
      if (imported > 0) await fetchChats()
      const fallbackSuffix = isGroupContext && speakerFallbackCount > 0
        ? ` Speaker attribution fell back to names for ${speakerFallbackCount} message${speakerFallbackCount === 1 ? '' : 's'}.`
        : ''
      if (imported > 0 && failures.length === 0) {
        if (fallbackSuffix) toast.warning(`Imported ${imported} chat${imported === 1 ? '' : 's'}.${fallbackSuffix}`)
        else toast.success(`Imported ${imported} chat${imported === 1 ? '' : 's'}`)
      } else if (imported > 0 && failures.length > 0) {
        toast.warning(`Imported ${imported}, failed ${failures.length}: ${failures[0].name} — ${failures[0].reason}.${fallbackSuffix}`.trim())
      } else if (failures.length === 1) {
        toast.error(`Failed to import ${failures[0].name}: ${failures[0].reason}`)
      } else if (failures.length > 1) {
        toast.error(`Failed to import ${failures.length} chats — first error: ${failures[0].reason}`)
      }
      setImportingSt(false)
    },
    [characterId, fetchChats, groupCharacterIds, isGroupContext]
  )

  return (
    <>
    <ModalShell isOpen={true} onClose={closeModal} closeOnEscape={false} maxWidth="clamp(340px, 94vw, min(560px, var(--lumiverse-content-max-width, 560px)))" className={styles.modal}>
          <CloseButton onClick={closeModal} variant="solid" position="absolute" />

          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <h3 className={styles.title}>Manage Chats</h3>
              <span className={styles.subtitle}>
                {(groupLabel || characterName)} &middot; {chats.length} chat{chats.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>

          <div className={styles.toolbar}>
            <div className={styles.searchWrap}>
              <Search size={14} />
              <input
                type="text"
                className={styles.searchInput}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search chats..."
              />
            </div>
            <Button size="sm" icon={<SortAsc size={13} />} onClick={cycleSortMode}>
              {sortLabel}
            </Button>
            <Button
              size="sm"
              icon={importing ? <Spinner size={13} /> : <Upload size={13} />}
              onClick={handleImportClick}
              disabled={importing}
              title="Import chat from exported JSON"
            >
              Import
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
              title={isGroupContext ? 'Import group chat from SillyTavern JSONL' : 'Import chat from SillyTavern JSONL'}
            >
              Import ST
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

          <div className={styles.body}>
            {loading && (
              <div className={styles.loading}>
                <Spinner size={16} />
                Loading chats...
              </div>
            )}

            {!loading && filteredChats.length === 0 && (
              <div className={styles.empty}>
                {search.trim() ? 'No chats match your search.' : 'No chats yet for this character.'}
              </div>
            )}

            {!loading &&
              filteredChats.map((chat) => {
                const isActive = chat.id === activeChatId
                const displayName = formatChatName(chat)
                return (
                  <div key={chat.id} className={clsx(styles.card, isActive && styles.cardActive)}>
                    <MessageSquare
                      size={18}
                      className={clsx(styles.cardIcon, isActive && styles.cardIconActive)}
                    />

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
                      <div className={styles.cardMeta}>
                        <span className={styles.cardMetaItem}>
                          <FileText size={11} />
                          {chat.message_count}
                        </span>
                        <span className={styles.cardMetaItem}>
                          <Clock size={11} />
                          {formatRelativeTime(chat.updated_at)}
                        </span>
                        {isActive && <span className={styles.activeBadge}>Active</span>}
                      </div>
                    </div>

                    <div className={styles.cardActions}>
                      {!isActive && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className={styles.actionBtnPrimary}
                          onClick={() => handleSwitch(chat.id)}
                          title="Switch to this chat"
                          icon={<ArrowRight size={14} />}
                        />
                      )}
                      {renamingId === chat.id ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className={styles.actionBtnPrimary}
                          onClick={() => handleConfirmRename(chat.id)}
                          title="Confirm rename"
                          icon={<Check size={14} />}
                        />
                      ) : (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleStartRename(chat)}
                          title="Rename chat"
                          icon={<Pencil size={14} />}
                        />
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleExport(chat.id, displayName)}
                        title="Export chat"
                        icon={<Download size={14} />}
                      />
                      {!isActive && (
                        <Button
                          size="icon"
                          variant="danger-ghost"
                          onClick={() => setDeleteTarget(chat)}
                          title="Delete chat"
                          icon={<Trash2 size={14} />}
                        />
                      )}
                    </div>
                  </div>
                )
              })}

            <button type="button" className={styles.newChatBtn} onClick={handleNewChat}>
              <Plus size={15} />
              New Chat
            </button>
          </div>
    </ModalShell>

      <ConfirmationModal
        isOpen={deleteTarget !== null}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
        title="Delete Chat"
        message={`Are you sure you want to delete "${deleteTarget ? formatChatName(deleteTarget) : ''}"? This action cannot be undone.`}
        variant="danger"
        confirmText="Delete"
        cancelText="Cancel"
      />
    </>
  )
}
