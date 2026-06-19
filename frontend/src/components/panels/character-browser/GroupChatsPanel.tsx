import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Users, Trash2, MessageSquarePlus } from 'lucide-react'
import { chatsApi } from '@/api/chats'
import { getCharacterAvatarThumbUrl, getCharacterAvatarThumbUrlById } from '@/lib/avatarUrls'
import { formatRelativeTime } from '@/lib/formatRelativeTime'
import { useStore } from '@/store'
import LazyImage from '@/components/shared/LazyImage'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { useGroupChatBrowser } from '@/hooks/useGroupChatBrowser'
import type { GroupedRecentChat } from '@/types/api'
import PanelFadeIn from '@/components/shared/PanelFadeIn'
import { Spinner } from '@/components/shared/Spinner'
import type { CharacterViewMode } from '@/types/store'
import styles from './GroupChatsPanel.module.css'
import clsx from 'clsx'

function MosaicThumb({ charIds, size = 'small' }: { charIds: string[]; size?: 'small' | 'large' }) {
  const characters = useStore((s) => s.characters)
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
            src={(() => {
              const entry = characters.find((c) => c.id === id)
              return (entry ? getCharacterAvatarThumbUrl(entry) : getCharacterAvatarThumbUrlById(id, null)) || ''
            })()}
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
  const { t } = useTranslation('panels')
  const navigate = useNavigate()
  const openModal = useStore((s) => s.openModal)
  const searchQuery = useStore((s) => s.searchQuery)
  const { groupChats, loading, removeLocal } = useGroupChatBrowser()
  const [deleteTarget, setDeleteTarget] = useState<GroupedRecentChat | null>(null)

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    const id = deleteTarget.latest_chat_id
    setDeleteTarget(null)
    try {
      await chatsApi.delete(id)
      removeLocal(id)
    } catch (err) {
      console.error('[GroupChatsPanel] Failed to delete:', err)
    }
  }, [deleteTarget, removeLocal])

  if (loading) {
    return (
      <div className={styles.empty}>
        <Spinner size={20} />
        <span>{t('groupChatsPanel.loading')}</span>
      </div>
    )
  }

  if (groupChats.length === 0) {
    if (searchQuery.trim()) {
      return (
        <div className={styles.empty}>
          <Users size={32} strokeWidth={1} className={styles.emptyIcon} />
          <p>{t('groupChatsPanel.noSearchResults')}</p>
        </div>
      )
    }
    return (
      <div className={styles.empty}>
        <Users size={32} strokeWidth={1} className={styles.emptyIcon} />
        <p>{t('groupChatsPanel.noGroupChatsYet')}</p>
        <button
          type="button"
          className={styles.createBtn}
          onClick={() => openModal('groupChatCreator')}
        >
          <MessageSquarePlus size={14} />
          {t('groupChatsPanel.createGroupChat')}
        </button>
      </div>
    )
  }

  const isGrid = viewMode === 'grid' || viewMode === 'single'

  return (
    <PanelFadeIn>
      <div className={styles.panel}>
        <div className={clsx(
        isGrid ? styles.gridLayout : styles.listLayout,
        viewMode === 'single' && styles.gridColumns1,
      )}>
        {groupChats.map((chat) => {
          const charIds: string[] = chat.group_character_ids ?? []
          const count = charIds.length
          const displayName = chat.group_name || chat.latest_chat_name || t('groupChatsPanel.defaultName')

          if (isGrid) {
            return (
              <button
                key={chat.latest_chat_id}
                type="button"
                className={styles.gridCard}
                onClick={() => navigate(`/chat/${chat.latest_chat_id}`)}
              >
                <div className={styles.gridCardImage}>
                  <MosaicThumb charIds={charIds} size="large" />
                </div>
                <div className={styles.gridCardOverlay} />
                <div className={styles.gridCardContent}>
                  <span className={styles.gridCardName}>{displayName}</span>
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
                  aria-label={t('groupChatsPanel.deleteAria')}
                >
                  <Trash2 size={12} />
                </button>
              </button>
            )
          }

          return (
            <button
              key={chat.latest_chat_id}
              type="button"
              className={styles.listCard}
              onClick={() => navigate(`/chat/${chat.latest_chat_id}`)}
            >
              <MosaicThumb charIds={charIds} size="small" />
              <div className={styles.listCardInfo}>
                <span className={styles.listCardName}>{displayName}</span>
                <span className={styles.listCardMeta}>
                  {t('groupChatsPanel.memberCount', { count })} &middot; {formatRelativeTime(chat.updated_at)}
                </span>
              </div>
              <button
                type="button"
                className={styles.listDeleteBtn}
                onClick={(e) => {
                  e.stopPropagation()
                  setDeleteTarget(chat)
                }}
                aria-label={t('groupChatsPanel.deleteAria')}
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
        title={t('groupChatsPanel.deleteTitle')}
        message={
          deleteTarget
            ? t('groupChatsPanel.deleteMessage', {
                name: deleteTarget.group_name || deleteTarget.latest_chat_name || t('groupChatsPanel.defaultName'),
              })
            : t('groupChatsPanel.deleteConfirmFallback')
        }
        variant="danger"
        confirmText={t('groupChatsPanel.delete')}
        />
      </div>
    </PanelFadeIn>
  )
}
