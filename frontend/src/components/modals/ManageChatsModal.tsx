import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import {
  X, Search, MessageSquare, Pencil, Download, Upload, Trash2,
  ArrowRight, Check, SortAsc, FileText, Clock, Loader2, Plus,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import { useStore } from '@/store'
import { chatsApi } from '@/api/chats'
import { get } from '@/api/client'
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
  const modalProps = useStore((s) => s.modalProps) as {
    characterId: string
    characterName: string
  }
  const activeChatId = useStore((s) => s.activeChatId)

  const { characterId, characterName } = modalProps

  const [chats, setChats] = useState<ChatSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('date')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null)
  const [importing, setImporting] = useState(false)

  const renameInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Fetch chats for this character
  const fetchChats = useCallback(async () => {
    try {
      setLoading(true)
      const data = await get<ChatSummary[]>('/chats/character-chats/' + characterId)
      setChats(data)
    } catch (err) {
      console.error('[ManageChats] Failed to fetch chats:', err)
    } finally {
      setLoading(false)
    }
  }, [characterId])

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

  // Escape to close
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
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [closeModal, renamingId])

  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) closeModal()
    },
    [closeModal]
  )

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
    try {
      const chat = await chatsApi.create({ character_id: characterId })
      closeModal()
      navigate('/chat/' + chat.id)
    } catch (err) {
      console.error('[ManageChats] Failed to create chat:', err)
    }
  }, [characterId, closeModal, navigate])

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
          console.error('[ManageChats] Invalid chat export format')
          return
        }

        await chatsApi.importChat(characterId, data)
        await fetchChats()
      } catch (err) {
        console.error('[ManageChats] Failed to import chat:', err)
      } finally {
        setImporting(false)
      }
    },
    [characterId, fetchChats]
  )

  return createPortal(
    <AnimatePresence>
      <motion.div
        className={styles.backdrop}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onMouseDown={(e) => { mouseDownTargetRef.current = e.target }}
        onClick={handleBackdropClick}
      >
        <motion.div
          className={styles.modal}
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        >
          <button onClick={closeModal} type="button" className={styles.closeBtn} aria-label="Close">
            <X size={16} />
          </button>

          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <h3 className={styles.title}>Manage Chats</h3>
              <span className={styles.subtitle}>
                {characterName} &middot; {chats.length} chat{chats.length !== 1 ? 's' : ''}
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
            <button type="button" className={styles.sortBtn} onClick={cycleSortMode}>
              <SortAsc size={13} />
              {sortLabel}
            </button>
            <button
              type="button"
              className={styles.sortBtn}
              onClick={handleImportClick}
              disabled={importing}
              title="Import chat from exported JSON"
            >
              {importing ? <Loader2 size={13} /> : <Upload size={13} />}
              Import
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
          </div>

          <div className={styles.body}>
            {loading && (
              <div className={styles.loading}>
                <Loader2 size={16} />
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
                        <button
                          type="button"
                          className={clsx(styles.actionBtn, styles.actionBtnPrimary)}
                          onClick={() => handleSwitch(chat.id)}
                          title="Switch to this chat"
                        >
                          <ArrowRight size={14} />
                        </button>
                      )}
                      {renamingId === chat.id ? (
                        <button
                          type="button"
                          className={clsx(styles.actionBtn, styles.actionBtnPrimary)}
                          onClick={() => handleConfirmRename(chat.id)}
                          title="Confirm rename"
                        >
                          <Check size={14} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={styles.actionBtn}
                          onClick={() => handleStartRename(chat)}
                          title="Rename chat"
                        >
                          <Pencil size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.actionBtn}
                        onClick={() => handleExport(chat.id, displayName)}
                        title="Export chat"
                      >
                        <Download size={14} />
                      </button>
                      {!isActive && (
                        <button
                          type="button"
                          className={clsx(styles.actionBtn, styles.actionBtnDanger)}
                          onClick={() => setDeleteTarget(chat)}
                          title="Delete chat"
                        >
                          <Trash2 size={14} />
                        </button>
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
        </motion.div>
      </motion.div>

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
    </AnimatePresence>,
    document.body
  )
}
