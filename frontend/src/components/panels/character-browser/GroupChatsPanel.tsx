import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { Users, Trash2, MessageSquarePlus, Loader2 } from 'lucide-react'
import { chatsApi } from '@/api/chats'
import { charactersApi } from '@/api/characters'
import { useStore } from '@/store'
import LazyImage from '@/components/shared/LazyImage'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { RecentChat } from '@/types/api'
import type { CharacterViewMode } from '@/types/store'
import styles from './GroupChatsPanel.module.css'
import clsx from 'clsx'

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

function MosaicThumb({ charIds, size = 'small' }: { charIds: string[]; size?: 'small' | 'large' }) {
  const displayIds = charIds.slice(0, 4)
  const count = charIds.length
  const mosaicClass =
    count === 2
      ? styles.mosaic2
      : count === 3
        ? styles.mosaic3
        : styles.mosaic4

  const iconSize = size === 'large' ? 20 : 14
  const wrapClass = size === 'large' ? styles.mosaicLarge : styles.mosaicSmall

  return (
    <div className={clsx(styles.mosaic, mosaicClass, wrapClass)}>
      {displayIds.map((id) => (
        <div key={id} className={styles.mosaicCell}>
          <LazyImage
            src={charactersApi.avatarUrl(id)}
            alt=""
            spinnerSize={iconSize}
            fallback={
              <div className={styles.mosaicFallback}>
                <Users size={iconSize} strokeWidth={1.5} />
              </div>
            }
          />
        </div>
      ))}
    </div>
  )
}

interface GroupChatsPanelProps {
  viewMode: CharacterViewMode
}

export default function GroupChatsPanel({ viewMode }: GroupChatsPanelProps) {
  const navigate = useNavigate()
  const openModal = useStore((s) => s.openModal)
  const [groupChats, setGroupChats] = useState<RecentChat[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<RecentChat | null>(null)

  const fetchGroupChats = useCallback(async () => {
    setLoading(true)
    try {
      const result = await chatsApi.listRecent({ limit: 200 })
      setGroupChats(result.data.filter((c) => c.metadata?.group === true))
    } catch (err) {
      console.error('[GroupChatsPanel] Failed to load:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchGroupChats()
  }, [fetchGroupChats])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    const id = deleteTarget.id
    setDeleteTarget(null)
    try {
      await chatsApi.delete(id)
      setGroupChats((prev) => prev.filter((c) => c.id !== id))
    } catch (err) {
      console.error('[GroupChatsPanel] Failed to delete:', err)
    }
  }, [deleteTarget])

  if (loading) {
    return (
      <div className={styles.empty}>
        <Loader2 size={20} className={styles.spin} />
        <span>Loading group chats...</span>
      </div>
    )
  }

  if (groupChats.length === 0) {
    return (
      <div className={styles.empty}>
        <Users size={32} strokeWidth={1} className={styles.emptyIcon} />
        <p>No group chats yet</p>
        <button
          type="button"
          className={styles.createBtn}
          onClick={() => openModal('groupChatCreator')}
        >
          <MessageSquarePlus size={14} />
          Create Group Chat
        </button>
      </div>
    )
  }

  const isGrid = viewMode === 'grid' || viewMode === 'columns'

  return (
    <div className={styles.panel}>
      <div className={clsx(
        isGrid ? styles.gridLayout : styles.listLayout,
        viewMode === 'columns' && styles.gridColumns2,
      )}>
        {groupChats.map((chat) => {
          const charIds: string[] = chat.metadata?.character_ids ?? []
          const count = charIds.length

          if (isGrid) {
            return (
              <button
                key={chat.id}
                type="button"
                className={styles.gridCard}
                onClick={() => navigate(`/chat/${chat.id}`)}
              >
                <div className={styles.gridCardImage}>
                  <MosaicThumb charIds={charIds} size="large" />
                </div>
                <div className={styles.gridCardOverlay} />
                <div className={styles.gridCardContent}>
                  <span className={styles.gridCardName}>{chat.name || 'Group Chat'}</span>
                  <div className={styles.gridCardMeta}>
                    <span className={styles.memberBadge}>
                      <Users size={9} strokeWidth={2} />
                      {count}
                    </span>
                    <span>{formatRelativeTime(chat.updated_at)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className={styles.gridDeleteBtn}
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleteTarget(chat)
                  }}
                  aria-label="Delete group chat"
                >
                  <Trash2 size={12} />
                </button>
              </button>
            )
          }

          return (
            <button
              key={chat.id}
              type="button"
              className={styles.listCard}
              onClick={() => navigate(`/chat/${chat.id}`)}
            >
              <MosaicThumb charIds={charIds} size="small" />
              <div className={styles.listCardInfo}>
                <span className={styles.listCardName}>{chat.name || 'Group Chat'}</span>
                <span className={styles.listCardMeta}>
                  {count} members &middot; {formatRelativeTime(chat.updated_at)}
                </span>
              </div>
              <button
                type="button"
                className={styles.listDeleteBtn}
                onClick={(e) => {
                  e.stopPropagation()
                  setDeleteTarget(chat)
                }}
                aria-label="Delete group chat"
              >
                <Trash2 size={12} />
              </button>
            </button>
          )
        })}
      </div>

      <ConfirmationModal
        isOpen={!!deleteTarget}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        title="Delete Group Chat"
        message={
          deleteTarget
            ? <>Are you sure you want to delete <strong>&quot;{deleteTarget.name || 'Group Chat'}&quot;</strong>?</>
            : 'Are you sure?'
        }
        variant="danger"
        confirmText="Delete"
      />
    </div>
  )
}
