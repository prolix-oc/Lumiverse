import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { formatRelativeTime } from '@/lib/formatRelativeTime'
import { previewText } from '@/lib/previewText'
import { Check, MessageSquare, Plus, MoreHorizontal, Pencil, Download, Trash2, Sparkles, Gamepad2 } from 'lucide-react'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { CloseButton } from '@/components/shared/CloseButton'
import ContextMenu, { type ContextMenuEntry } from '@/components/shared/ContextMenu'
import { ModalShell } from '@/components/shared/ModalShell'
import { Spinner } from '@/components/shared/Spinner'
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
  last_message_preview: string
  multiplayer?: boolean
}

interface ChatPickerModalProps {
  characterId: string
  characterName: string
  onSelect: (chatId: string) => void
  onDismiss: () => void
}

export default function ChatPickerModal({
  characterId,
  characterName,
  onSelect,
  onDismiss,
}: ChatPickerModalProps) {
  const { t } = useTranslation('modals')
  const { t: tc } = useTranslation('common')

  const formatChatName = useCallback((chat: ChatSummary) => {
    if (chat.name) return chat.name
    return t('chatPicker.unnamedChat', {
      date: new Date(chat.created_at * 1000).toLocaleString(),
    })
  }, [t])

  const [items, setItems] = useState<ChatSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null)
  const [activeMenuPos, setActiveMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null)
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)

  const renameInputRef = useRef<HTMLInputElement>(null)

  const closeActiveMenu = useCallback(() => {
    setActiveMenuId(null)
    setActiveMenuPos(null)
  }, [])

  const openActiveMenu = useCallback((chatId: string, trigger: HTMLElement) => {
    const rect = trigger.getBoundingClientRect()
    const viewportPadding = 8
    const estimatedMenuWidth = 180
    setActiveMenuId(chatId)
    setActiveMenuPos({
      x: Math.max(viewportPadding, rect.right - estimatedMenuWidth),
      y: Math.max(viewportPadding, rect.bottom + 6),
    })
  }, [])

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
          closeActiveMenu()
          return
        }
        if (deleteTarget) {
          setDeleteTarget(null)
          return
        }
        if (confirmDeleteAll) {
          setConfirmDeleteAll(false)
          return
        }
        onDismiss()
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onDismiss, renamingId, activeMenuId, deleteTarget, confirmDeleteAll, closeActiveMenu])

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

  const handleDeleteAll = async () => {
    try {
      await chatsApi.deleteCharacterChats(characterId)
      setItems([])
      onDismiss()
    } catch (err) {
      console.error('[Lumiverse] Failed to delete all chats:', err)
    }
    setConfirmDeleteAll(false)
  }

  const handleNewChat = async (options?: { memoryIsolation?: boolean }) => {
    try {
      setLoading(true)
      const metadata = options?.memoryIsolation ? { memory_isolation: true } : undefined
      const chat = await chatsApi.create({ character_id: characterId, metadata })
      onSelect(chat.id)
    } catch (err) {
      console.error('[Lumiverse] Failed to create new chat:', err)
      setLoading(false)
    }
  }

  const activeMenuItems: ContextMenuEntry[] = activeMenuId ? [
    {
      key: 'rename',
      label: t('chatPicker.menuRename'),
      icon: <Pencil size={14} />,
      onClick: () => {
        const item = items.find((chat) => chat.id === activeMenuId)
        if (!item) return
        setRenamingId(item.id)
        setRenameValue(item.name || '')
        closeActiveMenu()
      },
    },
    {
      key: 'export',
      label: t('chatPicker.menuExport'),
      icon: <Download size={14} />,
      onClick: () => {
        const item = items.find((chat) => chat.id === activeMenuId)
        if (!item) return
        handleExport(item.id, formatChatName(item))
        closeActiveMenu()
      },
    },
    {
      key: 'delete',
      label: t('chatPicker.menuDelete'),
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => {
        const item = items.find((chat) => chat.id === activeMenuId)
        if (!item) return
        setDeleteTarget(item)
        closeActiveMenu()
      },
    },
  ] : []

  return (
    <>
      <ModalShell isOpen onClose={onDismiss} maxWidth={560} maxHeight="80vh" closeOnEscape={false} className={styles.modal}>
        <CloseButton onClick={onDismiss} variant="solid" position="absolute" className={styles.closeBtnPos} />

        <div className={styles.header}>
          <h3 className={styles.title}>{t('chatPicker.title', { name: characterName })}</h3>
          <div className={styles.headerActions}>
            <span className={styles.count}>
              {loading ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <Spinner size={10} /> {t('chatPicker.loading')}
                </span>
              ) : (
                t('chatPicker.chatCount', { count: items.length })
              )}
            </span>
            {!loading && items.length > 1 && (
              <button
                type="button"
                className={styles.deleteAllBtn}
                onClick={() => setConfirmDeleteAll(true)}
                title={t('chatPicker.deleteAllChats')}
              >
                <Trash2 size={13} />
                {t('chatPicker.deleteAllChats')}
              </button>
            )}
          </div>
        </div>

        <div className={styles.list}>
          {/* Action Card: New Chat */}
          <button
            type="button"
            className={clsx(styles.card, styles.newChatCard)}
            onClick={() => handleNewChat()}
            disabled={loading}
          >
            <div className={styles.newChatIcon}>
              <Plus size={16} strokeWidth={2.5} />
            </div>
            <div className={styles.cardHeader}>
              <span className={styles.cardLabel}>{t('chatPicker.startNewChat')}</span>
            </div>
          </button>

          {/* Action Card: Fresh Chat — no character-scoped long-term memory */}
          <button
            type="button"
            className={clsx(styles.card, styles.freshChatCard)}
            onClick={() => handleNewChat({ memoryIsolation: true })}
            disabled={loading}
            title={t('chatPicker.freshChatTitle')}
          >
            <div className={styles.freshChatIcon}>
              <Sparkles size={14} strokeWidth={2.5} />
            </div>
            <div className={clsx(styles.cardHeader, styles.freshChatHeader)}>
              <span className={styles.cardLabel}>{t('chatPicker.startFreshChat')}</span>
              <span className={styles.freshChatSubtitle}>{t('chatPicker.freshChatSubtitle')}</span>
            </div>
          </button>

          {/* List of existing chats */}
          <AnimatePresence initial={false}>
          {!loading && items.map((item, i) => {
            const isActive = i === 0 // The first one is implicitly the most recent
            const isRenaming = renamingId === item.id
            const isMenuOpen = activeMenuId === item.id

            return (
              <motion.div
                key={item.id}
                className={clsx(styles.card, isActive && styles.cardActive)}
                style={{ animationDelay: `${Math.min(i * 40, 200)}ms`, zIndex: isMenuOpen ? 10 : undefined }}
                role="button"
                tabIndex={isRenaming ? -1 : 0}
                aria-disabled={isRenaming || isMenuOpen}
                onClick={() => {
                  if (!isRenaming && !isMenuOpen) onSelect(item.id)
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (isRenaming || isMenuOpen) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(item.id)
                  }
                }}
                exit={{ opacity: 0, x: -16, transition: { duration: 0.18 } }}
                whileHover={{ scale: isMenuOpen ? 1 : 1.01 }}
                whileTap={{ scale: isMenuOpen ? 1 : 0.99 }}
              >
                <div className={styles.cardHeader}>
                  <div className={styles.cardTitleRow}>
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
                        {t('chatPicker.mostRecent')}
                      </span>
                    )}
                    {item.multiplayer && (
                      <span className={styles.activeBadge} style={{ color: 'var(--lumiverse-accent, #6366f1)' }}>
                        <Gamepad2 size={10} />
                        Multiplayer
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    className={clsx(styles.menuBtn, isMenuOpen && styles.menuBtnActive)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (isMenuOpen) {
                        closeActiveMenu()
                        return
                      }
                      openActiveMenu(item.id, e.currentTarget)
                    }}
                    title={t('chatPicker.moreOptions')}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </div>

                <div className={styles.cardPreview}>
                  {item.last_message_preview && (
                    <p className={styles.previewText}>
                      {previewText(item.last_message_preview)}
                    </p>
                  )}
                  <div className={styles.metaRow}>
                    <span className={styles.metaItem}>
                      <MessageSquare size={12} />
                      {t('chatPicker.messageCount', { count: item.message_count })}
                    </span>
                    <span className={styles.metaItem}>
                      {t('chatPicker.updated', { time: formatRelativeTime(item.updated_at) })}
                    </span>
                  </div>
                </div>
              </motion.div>
            )
          })}
          </AnimatePresence>
        </div>
      </ModalShell>

      <ContextMenu position={activeMenuPos} items={activeMenuItems} onClose={closeActiveMenu} />

      <ConfirmationModal
        isOpen={deleteTarget !== null}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        title={t('chatPicker.deleteTitle')}
        message={t('chatPicker.deleteMessage', { name: deleteTarget ? formatChatName(deleteTarget) : '' })}
        variant="danger"
        confirmText={tc('actions.delete')}
        cancelText={tc('actions.cancel')}
      />

      <ConfirmationModal
        isOpen={confirmDeleteAll}
        onConfirm={handleDeleteAll}
        onCancel={() => setConfirmDeleteAll(false)}
        title={t('chatPicker.deleteAllTitle')}
        message={t('chatPicker.deleteAllMessage', { count: items.length, name: characterName })}
        variant="danger"
        confirmText={tc('actions.delete')}
        cancelText={tc('actions.cancel')}
      />
    </>
  )
}
