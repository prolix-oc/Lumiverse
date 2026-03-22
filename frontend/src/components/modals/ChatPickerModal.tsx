import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { X, Check, MessageSquare, Plus, MoreHorizontal, Pencil, Download, Trash2, Loader2 } from 'lucide-react'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { get } from '@/api/client'
import { chatsApi } from '@/api/chats'
import styles from './ChatPickerModal.module.css'
import clsx from 'clsx'

interface ChatSummary {
  id: string
  name: string | null
  message_count: number
  created_at: number
  updated_at: number
}

interface ChatPickerModalProps {
  characterId: string
  characterName: string
  onSelect: (chatId: string) => void
  onDismiss: () => void
}

function formatChatName(chat: ChatSummary): string {
  if (chat.name) return chat.name
  return `Chat ${new Date(chat.created_at * 1000).toLocaleString()}`
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp * 1000
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp * 1000).toLocaleDateString()
}

export default function ChatPickerModal({
  characterId,
  characterName,
  onSelect,
  onDismiss,
}: ChatPickerModalProps) {
  const [items, setItems] = useState<ChatSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null)

  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let mounted = true
    const fetchChats = async () => {
      setLoading(true)
      try {
        const chats = await get<ChatSummary[]>('/chats/character-chats/' + characterId)
        if (mounted) setItems(chats)
      } catch (err) {
        console.error('[Lumiverse] Failed to fetch character chats:', err)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    fetchChats()
    return () => { mounted = false }
  }, [characterId])

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (renamingId) {
          setRenamingId(null)
          return
        }
        if (activeMenuId) {
          setActiveMenuId(null)
          return
        }
        if (deleteTarget) {
          setDeleteTarget(null)
          return
        }
        onDismiss()
      }
    }
    const handleClickOutside = () => {
      if (activeMenuId) setActiveMenuId(null)
    }
    document.addEventListener('keydown', handleEscape)
    document.addEventListener('click', handleClickOutside)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('click', handleClickOutside)
      document.body.style.overflow = ''
    }
  }, [onDismiss, renamingId, activeMenuId, deleteTarget])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onDismiss()
    },
    [onDismiss]
  )

  const handleConfirmRename = async (chatId: string) => {
    const trimmed = renameValue.trim()
    if (trimmed) {
      try {
        await chatsApi.update(chatId, { name: trimmed })
        setItems(prev => prev.map(c => c.id === chatId ? { ...c, name: trimmed } : c))
      } catch (err) {
        console.error('[Lumiverse] Failed to rename chat:', err)
      }
    }
    setRenamingId(null)
  }

  const handleExport = async (chatId: string, chatName: string) => {
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
      console.error('[Lumiverse] Failed to export chat:', err)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await chatsApi.delete(deleteTarget.id)
      setItems(prev => {
        const newChats = prev.filter(c => c.id !== deleteTarget.id)
        if (newChats.length === 0) {
          onDismiss()
          return prev
        }
        return newChats
      })
    } catch (err) {
      console.error('[Lumiverse] Failed to delete chat:', err)
    }
    setDeleteTarget(null)
  }

  const handleNewChat = async () => {
    try {
      setLoading(true)
      const chat = await chatsApi.create({ character_id: characterId })
      onSelect(chat.id)
    } catch (err) {
      console.error('[Lumiverse] Failed to create new chat:', err)
      setLoading(false)
    }
  }

  return createPortal(
    <AnimatePresence>
      <motion.div
        className={styles.backdrop}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={handleBackdropClick}
      >
        <motion.div
          className={styles.modal}
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        >
          <button
            onClick={onDismiss}
            type="button"
            className={styles.closeBtn}
            aria-label="Close"
          >
            <X size={16} />
          </button>

          <div className={styles.header}>
            <h3 className={styles.title}>Resume Chat &middot; {characterName}</h3>
            <span className={styles.count}>
              {loading ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <Loader2 size={10} className={styles.spin} /> Loading...
                </span>
              ) : (
                `${items.length} chats`
              )}
            </span>
          </div>

          <div className={styles.list}>
            {/* Action Card: New Chat */}
            <button
              type="button"
              className={clsx(styles.card, styles.newChatCard)}
              onClick={handleNewChat}
              disabled={loading}
            >
              <div className={styles.newChatIcon}>
                <Plus size={16} strokeWidth={2.5} />
              </div>
              <div className={styles.cardHeader}>
                <span className={styles.cardLabel}>Start New Chat</span>
              </div>
            </button>

            {/* List of existing chats */}
            <AnimatePresence initial={false}>
            {!loading && items.map((item, i) => {
              const isActive = i === 0 // The first one is implicitly the most recent
              const isRenaming = renamingId === item.id
              const isMenuOpen = activeMenuId === item.id

              return (
                <motion.button
                  key={item.id}
                  className={clsx(styles.card, isActive && styles.cardActive)}
                  style={{ animationDelay: `${Math.min(i * 40, 200)}ms`, zIndex: isMenuOpen ? 10 : undefined }}
                  onClick={() => {
                    if (!isRenaming && !isMenuOpen) onSelect(item.id)
                  }}
                  exit={{ opacity: 0, x: -16, transition: { duration: 0.18 } }}
                  whileHover={{ scale: isMenuOpen ? 1 : 1.01 }}
                  whileTap={{ scale: isMenuOpen ? 1 : 0.99 }}
                >
                  <div className={styles.cardHeader}>
                    {isRenaming ? (
                      <input
                        ref={renameInputRef}
                        type="text"
                        className={styles.editInput}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleConfirmRename(item.id)
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        onBlur={() => handleConfirmRename(item.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className={styles.cardLabel}>
                        {formatChatName(item)}
                      </span>
                    )}
                    
                    {isActive && !isRenaming && (
                      <span className={styles.activeBadge}>
                        <Check size={10} />
                        Most Recent
                      </span>
                    )}

                    <button
                      type="button"
                      className={clsx(styles.menuBtn, isMenuOpen && styles.menuBtnActive)}
                      onClick={(e) => {
                        e.stopPropagation()
                        setActiveMenuId(isMenuOpen ? null : item.id)
                      }}
                      title="More options"
                    >
                      <MoreHorizontal size={14} />
                    </button>

                    <AnimatePresence>
                      {isMenuOpen && (
                        <motion.div
                          className={styles.dropdown}
                          initial={{ opacity: 0, scale: 0.95, y: -5 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95, y: -5 }}
                          transition={{ duration: 0.15 }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className={styles.dropdownItem}
                            onClick={(e) => {
                              e.stopPropagation()
                              setRenamingId(item.id)
                              setRenameValue(item.name || '')
                              setActiveMenuId(null)
                            }}
                          >
                            <Pencil size={14} />
                            Rename
                          </button>
                          <button
                            type="button"
                            className={styles.dropdownItem}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleExport(item.id, formatChatName(item))
                              setActiveMenuId(null)
                            }}
                          >
                            <Download size={14} />
                            Export
                          </button>
                          <button
                            type="button"
                            className={clsx(styles.dropdownItem, styles.dropdownItemDanger)}
                            onClick={(e) => {
                              e.stopPropagation()
                              setDeleteTarget(item)
                              setActiveMenuId(null)
                            }}
                          >
                            <Trash2 size={14} />
                            Delete
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                  
                  <div className={styles.cardPreview}>
                    <div className={styles.metaRow}>
                      <span className={styles.metaItem}>
                        <MessageSquare size={12} />
                        {item.message_count} messages
                      </span>
                      <span className={styles.metaItem}>
                        Updated {formatRelativeTime(item.updated_at)}
                      </span>
                    </div>
                  </div>
                </motion.button>
              )
            })}
            </AnimatePresence>
          </div>
        </motion.div>
      </motion.div>

      <ConfirmationModal
        isOpen={deleteTarget !== null}
        onConfirm={handleDelete}
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
