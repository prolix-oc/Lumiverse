import { useState, useEffect, useCallback, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { MessageSquarePlus, MessageSquare, Trash2, Users, LogOut, FlaskConical } from 'lucide-react'
import { Spinner } from '@/components/shared/Spinner'
import { chatsApi } from '@/api/chats'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import { getCharacterAvatarLargeUrlById } from '@/lib/avatarUrls'
import { formatRelativeTime } from '@/lib/formatRelativeTime'
import { useStore } from '@/store'
import { useScrollGate } from '@/hooks/useScrollGate'
import { warmCharacterPalette } from '@/hooks/useCharacterTheme'
import LazyImage from '@/components/shared/LazyImage'
import type { GroupedRecentChat } from '@/types/api'
import styles from './LandingPage.module.css'
import clsx from 'clsx'
import type { TFunction } from 'i18next'

function getRecentChatDisplayName(item: GroupedRecentChat, t: TFunction<'landing'>): string {
  return item.is_group
    ? (item.group_name || item.latest_chat_name || t('groupChat'))
    : item.character_name
}

function getRecentChatSubtitle(item: GroupedRecentChat, t: TFunction<'landing'>): string {
  const displayName = getRecentChatDisplayName(item, t)
  if (item.latest_chat_name && item.latest_chat_name !== displayName) {
    return item.latest_chat_name
  }

  if (item.is_group && item.chat_count > 1) return t('subtitle.chooseGroupThreads')
  if (item.is_group) return t('subtitle.resumeGroupThread')
  if (item.chat_count > 1) return t('subtitle.chooseConversations')
  return t('subtitle.resumeConversation')
}

function getRecentChatKey(item: GroupedRecentChat): string {
  return item.is_group ? item.latest_chat_id : item.character_id
}

interface RecentChatAvatarProps {
  item: GroupedRecentChat
  variant: 'card' | 'compact'
}

function RecentChatAvatar({ item, variant }: RecentChatAvatarProps) {
  const characters = useStore((s) => s.characters)
  const isGroup = item.is_group && item.group_character_ids && item.group_character_ids.length > 0

  const liveCharacter = item.character_id
    ? characters.find((entry) => entry.id === item.character_id) ?? null
    : null
  const avatarUrl = item.character_id
    ? getCharacterAvatarLargeUrlById(
        item.character_id,
        liveCharacter?.image_id ?? item.character_image_id
      )
    : null

  const mosaicIds = isGroup ? item.group_character_ids!.slice(0, 4) : []
  const mosaicClass = isGroup
    ? mosaicIds.length === 2
      ? styles.groupMosaic2
      : mosaicIds.length === 3
        ? styles.groupMosaic3
        : styles.groupMosaic4
    : undefined

  const imageClassName = variant === 'card' ? styles.cardImage : styles.listAvatar
  const fallbackClassName = clsx(styles.cardAvatarFallback, variant === 'compact' && styles.listAvatarFallback)

  if (isGroup) {
    return (
      <div className={imageClassName}>
        <div className={clsx(styles.groupMosaic, mosaicClass)}>
          {mosaicIds.map((id) => {
            const char = characters.find((c) => c.id === id)
            const url = getCharacterAvatarLargeUrlById(id, char?.image_id ?? null)
            return (
              <div key={id} className={styles.mosaicCell}>
                <LazyImage
                  src={url}
                  alt=""
                  fallback={
                    <div className={styles.mosaicFallback}>
                      <Users size={variant === 'card' ? 16 : 14} strokeWidth={1.5} />
                    </div>
                  }
                />
              </div>
            )
          })}
        </div>
        {variant === 'card' ? <div className={styles.groupOverlay} /> : null}
      </div>
    )
  }

  return (
    <div className={imageClassName}>
      <LazyImage
        src={avatarUrl}
        alt={item.character_name}
        fallback={
          <div className={fallbackClassName}>
            {item.character_name?.[0]?.toUpperCase() || '?'}
          </div>
        }
      />
      {variant === 'card' ? <div className={styles.cardImageOverlay} /> : null}
    </div>
  )
}

function SkeletonCard({ index }: { index: number }) {
  return (
    <motion.div
      className={styles.skeletonCard}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.05, 0.35) }}
    >
      <div className={styles.skeletonImage} />
      <div className={styles.skeletonContent}>
        <div className={styles.skeletonTitle} />
        <div className={styles.skeletonMeta} />
      </div>
    </motion.div>
  )
}

function SkeletonListItem({ index }: { index: number }) {
  return (
    <motion.div
      className={styles.listSkeleton}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.04, 0.35) }}
    >
      <div className={styles.listSkeletonAvatar} />
      <div className={styles.listSkeletonBody}>
        <div className={styles.listSkeletonTitle} />
        <div className={styles.listSkeletonMeta} />
      </div>
    </motion.div>
  )
}

// Last-known landing layout + item count, persisted so the skeleton matches
// the real layout from the very first frame — before settings arrive from
// bootstrap. Without it the page sat blank until settingsLoaded, then showed
// a fixed 8 placeholders regardless of how many items would render.
const LANDING_HINT_KEY = '__lumiverse_landing_hint'
const SKELETON_MAX = 24

interface LandingHint {
  layout?: 'cards' | 'compact'
  count?: number
}

function readLandingHint(): LandingHint {
  try {
    const parsed = JSON.parse(localStorage.getItem(LANDING_HINT_KEY) || '')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeLandingHint(hint: LandingHint) {
  try {
    localStorage.setItem(LANDING_HINT_KEY, JSON.stringify(hint))
  } catch { /* private mode etc. — hint is best-effort */ }
}

function EmptyState() {
  const { t } = useTranslation('landing')
  return (
    <motion.div
      className={styles.emptyState}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className={styles.emptyIcon}>
        <MessageSquarePlus size={48} strokeWidth={1} />
      </div>
      <h3>{t('empty.title')}</h3>
      <p>{t('empty.description')}</p>
    </motion.div>
  )
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
}

interface ChatCardProps {
  item: GroupedRecentChat
  onClick: () => void
  onDelete?: () => void
}

function ChatCard({ item, onClick, onDelete }: ChatCardProps) {
  const { t } = useTranslation('landing')
  const tiltRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const rectRef = useRef<DOMRect | null>(null)

  const isGroup = item.is_group && item.group_character_ids && item.group_character_ids.length > 0

  const handleMouseEnter = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const tilt = tiltRef.current
    const card = cardRef.current
    if (!tilt || !card) return
    rectRef.current = tilt.getBoundingClientRect()
    tilt.classList.add(styles.tilting)
    const rect = rectRef.current
    const mx = (e.clientX - rect.left) / rect.width
    const my = (e.clientY - rect.top) / rect.height
    const tiltX = (mx - 0.5) * 2
    const tiltY = (my - 0.5) * 2
    tilt.style.transform =
      `rotateX(${(my - 0.5) * -18}deg) rotateY(${(mx - 0.5) * 18}deg) scale3d(1.04,1.04,1.04)`
    tilt.style.setProperty('--tilt-x', String(tiltX))
    tilt.style.setProperty('--tilt-y', String(tiltY))
    card.style.setProperty('--shine-x', `${mx * 100}%`)
    card.style.setProperty('--shine-y', `${my * 100}%`)
  }, [])

  const handleMouseMove = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const tilt = tiltRef.current
    const card = cardRef.current
    const rect = rectRef.current
    if (!tilt || !card || !rect) return
    const mx = (e.clientX - rect.left) / rect.width
    const my = (e.clientY - rect.top) / rect.height
    const tiltX = (mx - 0.5) * 2
    const tiltY = (my - 0.5) * 2
    tilt.style.transform =
      `rotateX(${(my - 0.5) * -18}deg) rotateY(${(mx - 0.5) * 18}deg) scale3d(1.04,1.04,1.04)`
    tilt.style.setProperty('--tilt-x', String(tiltX))
    tilt.style.setProperty('--tilt-y', String(tiltY))
    card.style.setProperty('--shine-x', `${mx * 100}%`)
    card.style.setProperty('--shine-y', `${my * 100}%`)
  }, [])

  const handleMouseLeave = useCallback(() => {
    const tilt = tiltRef.current
    const card = cardRef.current
    if (!tilt || !card) return
    tilt.classList.remove(styles.tilting)
    tilt.style.transform = ''
    tilt.style.removeProperty('--tilt-x')
    tilt.style.removeProperty('--tilt-y')
    card.style.removeProperty('--shine-x')
    card.style.removeProperty('--shine-y')
    rectRef.current = null
  }, [])

  const displayName = getRecentChatDisplayName(item, t)

  return (
    <div
      ref={tiltRef}
      className={styles.cardTilt}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div
        ref={cardRef}
        className={clsx(styles.card, isGroup && styles.groupCard)}
      >
        {onDelete && (
          <button
            type="button"
            className={styles.deleteBtn}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            title={!item.is_group && item.chat_count > 1 ? t('deleteAllChats') : t('deleteChat')}
          >
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        )}
        <button type="button" className={styles.cardBtn} onClick={onClick}>
          <RecentChatAvatar item={item} variant="card" />
          <div className={styles.cardContent}>
            <h3 className={styles.cardName}>{displayName}</h3>
            <div className={styles.cardMeta}>
              {isGroup ? (
                <span className={styles.groupBadge}>
                  <Users size={10} strokeWidth={2} />
                  {item.group_character_ids!.length}
                </span>
              ) : item.chat_count > 1 ? (
                <span className={styles.chatCountBadge}>
                  <MessageSquare size={10} strokeWidth={2} />
                  {item.chat_count}
                </span>
              ) : null}
              <span className={styles.cardTime}>{formatRelativeTime(item.updated_at)}</span>
            </div>
          </div>
        </button>
      </div>
    </div>
  )
}

function ChatListItem({ item, onClick, onDelete }: ChatCardProps) {
  const { t } = useTranslation('landing')
  const isGroup = item.is_group && item.group_character_ids && item.group_character_ids.length > 0
  const displayName = getRecentChatDisplayName(item, t)
  const subtitle = getRecentChatSubtitle(item, t)

  return (
    <div className={clsx(styles.listItem, isGroup && styles.listItemGroup)}>
      {onDelete && (
        <button
          type="button"
          className={styles.listDeleteBtn}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title={t('deleteChat')}
        >
          <Trash2 size={14} strokeWidth={1.5} />
        </button>
      )}

      <button type="button" className={styles.listBtn} onClick={onClick}>
        <RecentChatAvatar item={item} variant="compact" />
        <div className={styles.listBody}>
          <div className={styles.listTopRow}>
            <h3 className={styles.listName}>{displayName}</h3>
            <span className={styles.listTime}>{formatRelativeTime(item.updated_at)}</span>
          </div>

          <div className={styles.listBottomRow}>
            <p className={styles.listSubtitle}>{subtitle}</p>
            <div className={styles.listMeta}>
              {isGroup ? (
                <span className={styles.groupBadge}>
                  <Users size={10} strokeWidth={2} />
                  {item.group_character_ids!.length}
                </span>
              ) : item.chat_count > 1 ? (
                <span className={styles.chatCountBadge}>
                  <MessageSquare size={10} strokeWidth={2} />
                  {item.chat_count}
                </span>
              ) : (
                <span className={styles.listStatusPill}>{t('active')}</span>
              )}
            </div>
          </div>
        </div>
      </button>
    </div>
  )
}

export default function LandingPage() {
  const { t } = useTranslation('landing')
  const { t: tc } = useTranslation('common')
  const navigate = useNavigate()
  const landingPageChatsDisplayed = useStore((s) => s.landingPageChatsDisplayed)
  const landingPageLayoutMode = useStore((s) => s.landingPageLayoutMode)
  const settingsLoaded = useStore((s) => s.settingsLoaded)
  const openModal = useStore((s) => s.openModal)
  const logout = useStore((s) => s.logout)
  const authUser = useStore((s) => s.user)
  const accountLabel = authUser?.username || authUser?.name || t('account')

  const [items, setItems] = useState<GroupedRecentChat[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [creatingTempChat, setCreatingTempChat] = useState(false)
  const [tempChatMenuOpen, setTempChatMenuOpen] = useState(false)
  const tempChatMenuRef = useRef<HTMLDivElement>(null)
  const tempChatMenuOpenedAt = useRef(0)

  const profiles = useStore((s) => s.profiles)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)
  const loomRegistry = useStore((s) => s.loomRegistry)
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) ?? profiles.find((p) => p.is_default) ?? null,
    [profiles, activeProfileId]
  )
  const activePresetName = activeLoomPresetId ? loomRegistry[activeLoomPresetId]?.name ?? null : null

  // pointerdown + openedAt guard per the project's Android outside-click rule
  useEffect(() => {
    if (!tempChatMenuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (Date.now() - tempChatMenuOpenedAt.current < 100) return
      if (tempChatMenuRef.current?.contains(e.target as Node)) return
      setTempChatMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [tempChatMenuOpen])

  // Temporary chats are disposable by contract: landing on the home page
  // sweeps any the user left behind (closed tab, back navigation, etc.).
  useEffect(() => {
    chatsApi.deleteTemporary().catch(() => {})
  }, [])

  // Skeleton shape/count for the pre-settings window and the fetch window.
  // Before settings arrive the store only has defaults, so fall back to the
  // persisted last-known layout and item count.
  const [landingHint] = useState(readLandingHint)
  const skeletonLayout = settingsLoaded
    ? landingPageLayoutMode
    : landingHint.layout ?? landingPageLayoutMode
  const expectedCount = settingsLoaded
    ? Math.min(landingHint.count ?? landingPageChatsDisplayed, landingPageChatsDisplayed)
    : landingHint.count ?? landingPageChatsDisplayed
  const skeletonCount = Math.max(1, Math.min(expectedCount, SKELETON_MAX))

  useEffect(() => {
    if (!settingsLoaded || loading) return
    writeLandingHint({
      layout: landingPageLayoutMode,
      count: Math.min(items.length, landingPageChatsDisplayed),
    })
  }, [settingsLoaded, loading, landingPageLayoutMode, items.length, landingPageChatsDisplayed])

  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useScrollGate(scrollRef)

  const fetchChats = useCallback(async () => {
    if (!settingsLoaded) return

    // Bootstrap delivers the first recent-chats page alongside settings —
    // consume it once instead of issuing another round trip. Later runs
    // (WS chat-deleted, limit changes, revisits) find it cleared and fetch.
    const preload = useStore.getState().landingRecentChats
    if (preload) {
      useStore.getState().setLandingRecentChats(null)
      setItems(preload.data)
      setTotal(preload.total)
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const result = await chatsApi.listRecentGrouped({ limit: landingPageChatsDisplayed })
      setItems(result.data)
      setTotal(result.total)
    } catch (err: any) {
      console.error('[Lumiverse] Error fetching chats:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [landingPageChatsDisplayed, settingsLoaded])

  const loadMore = useCallback(async () => {
    if (loadingMore || items.length >= total) return
    setLoadingMore(true)
    try {
      const result = await chatsApi.listRecentGrouped({
        limit: landingPageChatsDisplayed,
        offset: items.length,
      })
      setItems((prev) => [...prev, ...result.data])
      setTotal(result.total)
    } catch (err: any) {
      console.error('[Lumiverse] Error loading more chats:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, items.length, total, landingPageChatsDisplayed])

  useEffect(() => {
    fetchChats()
  }, [fetchChats])

  useEffect(() => {
    return wsClient.on(EventType.CHAT_DELETED, () => {
      fetchChats()
    })
  }, [fetchChats])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || items.length >= total || loading) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMore()
      },
      { rootMargin: '200px' }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [items.length, total, loading, loadMore])

  const handleChatClick = useCallback(
    (item: GroupedRecentChat) => {
      // Warm the avatar palette in parallel with the route change + chat
      // fetch so character-aware theming applies with first paint instead of
      // after the character record round-trips.
      warmCharacterPalette(item.character_id, item.character_image_id)

      if (item.is_group) {
        const groupCharacterIds = item.group_character_ids ?? []
        if (item.chat_count > 1 && groupCharacterIds.length > 1) {
          openModal('manageChats', {
            characterId: item.character_id,
            characterName: getRecentChatDisplayName(item, t),
            isGroupChat: true,
            groupCharacterIds,
          })
          return
        }
        navigate(`/chat/${item.latest_chat_id}`)
        return
      }

      if (item.chat_count === 1) {
        navigate(`/chat/${item.latest_chat_id}`)
        return
      }

      openModal('chatPicker', {
        characterId: item.character_id,
        characterName: item.character_name,
        onSelect: (chatId: string) => navigate(`/chat/${chatId}`)
      })
    },
    [navigate, openModal, t]
  )

  const handleDeleteChat = useCallback(
    (item: GroupedRecentChat) => {
      const label = item.is_group
        ? t('deleteLabelGroup', { name: item.group_name || item.latest_chat_name || t('untitled') })
        : t('deleteLabelChat', { name: item.character_name })
      openModal('confirm', {
        title: t('deleteChatTitle'),
        message: t('deleteChatConfirm', { label }),
        variant: 'danger',
        confirmText: tc('actions.delete'),
        onConfirm: async () => {
          try {
            await chatsApi.delete(item.latest_chat_id)
            setItems((prev) => prev.filter((i) => i.latest_chat_id !== item.latest_chat_id))
            setTotal((prev) => prev - 1)
          } catch (err: any) {
            console.error('[Lumiverse] Error deleting chat:', err)
          }
        },
      })
    },
    [openModal, t, tc]
  )

  const handleDeleteAllChats = useCallback(
    (item: GroupedRecentChat) => {
      openModal('confirm', {
        title: t('deleteAllChatsTitle'),
        message: t('deleteAllChatsConfirm', { count: item.chat_count, name: item.character_name }),
        variant: 'danger',
        confirmText: tc('actions.delete'),
        onConfirm: async () => {
          try {
            await chatsApi.deleteCharacterChats(item.character_id)
            setItems((prev) => prev.filter((i) => i.character_id !== item.character_id))
            setTotal((prev) => prev - 1)
          } catch (err: any) {
            console.error('[Lumiverse] Error deleting all chats:', err)
          }
        },
      })
    },
    [openModal, t, tc]
  )

  const handleNewChat = useCallback(() => {
    navigate('/characters')
  }, [navigate])

  const handleTempChat = useCallback(async (noPreset: boolean) => {
    if (creatingTempChat) return
    setCreatingTempChat(true)
    setTempChatMenuOpen(false)
    try {
      const chat = await chatsApi.createTemporary({ noPreset })
      navigate(`/chat/${chat.id}`)
    } catch (err: any) {
      console.error('[Lumiverse] Error creating temporary chat:', err)
      setCreatingTempChat(false)
    }
  }, [creatingTempChat, navigate])

  const toggleTempChatMenu = useCallback(() => {
    setTempChatMenuOpen((open) => {
      if (!open) tempChatMenuOpenedAt.current = Date.now()
      return !open
    })
  }, [])

  const handleLogout = useCallback(() => {
    openModal('confirm', {
      title: t('logOut.title'),
      message: t('logOut.message'),
      confirmText: t('logOut.confirm'),
      onConfirm: async () => {
        try {
          await logout()
        } catch (err) {
          console.error('[Lumiverse] Logout failed:', err)
        }
      },
    })
  }, [openModal, logout, t])

  const hasMore = items.length < total

  return (
    <div className={styles.container} ref={scrollRef}>
      <div className={styles.bg}>
        <div className={clsx(styles.bgGlow, styles.bgGlow1)} />
        <div className={clsx(styles.bgGlow, styles.bgGlow2)} />
        <div className={clsx(styles.bgGlow, styles.bgGlow3)} />
      </div>

      <div className={styles.grid} />

      <motion.div
        className={styles.content}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
      >
        <motion.header
          className={styles.header}
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
        >
          <div className={styles.logo}>
            <div className={styles.logoIcon}>
              <div className={styles.logoGlow} />
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="28" height="28">
                <g transform="rotate(-12, 32, 32)">
                  <ellipse cx="32" cy="12" rx="18" ry="6" fill="#8B5A2B" />
                  <ellipse cx="32" cy="12" rx="14" ry="4" fill="#A0522D" />
                  <rect x="14" y="12" width="36" height="40" fill="#8B5FC7" />
                  <line x1="14" y1="18" x2="50" y2="18" stroke="#7A4EB8" strokeWidth="1.5" />
                  <line x1="14" y1="24" x2="50" y2="24" stroke="#7A4EB8" strokeWidth="1.5" />
                  <line x1="14" y1="30" x2="50" y2="30" stroke="#7A4EB8" strokeWidth="1.5" />
                  <line x1="14" y1="36" x2="50" y2="36" stroke="#7A4EB8" strokeWidth="1.5" />
                  <line x1="14" y1="42" x2="50" y2="42" stroke="#7A4EB8" strokeWidth="1.5" />
                  <line x1="14" y1="48" x2="50" y2="48" stroke="#7A4EB8" strokeWidth="1.5" />
                  <rect x="14" y="12" width="8" height="40" fill="#A78BD4" opacity="0.5" />
                  <ellipse cx="32" cy="52" rx="18" ry="6" fill="#8B5A2B" />
                  <rect x="14" y="48" width="36" height="4" fill="#8B5FC7" />
                  <ellipse cx="32" cy="52" rx="14" ry="4" fill="#A0522D" />
                  <ellipse cx="32" cy="52" rx="5" ry="2" fill="#5D3A1A" />
                  <path d="M 48 35 Q 55 38 52 45 Q 49 52 56 58" fill="none" stroke="#8B5FC7" strokeWidth="2" strokeLinecap="round" />
                </g>
              </svg>
            </div>
            <div className={styles.logoText}>
              <h1>{tc('appName')}</h1>
              <button type="button" className={styles.taglineBtn} onClick={handleNewChat}>
                <span>{t('tagline')}</span>
                <MessageSquarePlus size={13} strokeWidth={1.5} />
              </button>
            </div>
          </div>
          <div className={styles.headerActions}>
            <div className={styles.tempChatWrap} ref={tempChatMenuRef}>
              <button
                type="button"
                className={styles.accountBtn}
                onClick={toggleTempChatMenu}
                disabled={creatingTempChat}
                title={
                  activeProfile
                    ? t('tempChatTitleWithProfile', { name: activeProfile.name })
                    : t('tempChatTitle')
                }
              >
                <span className={styles.accountName}>
                  {activeProfile
                    ? t('tempChatWithProfile', { name: activeProfile.name })
                    : t('tempChat')}
                </span>
                <FlaskConical size={13} strokeWidth={1.5} />
              </button>
              {tempChatMenuOpen && (
                <div className={styles.tempChatMenu}>
                  <button type="button" className={styles.tempChatMenuItem} onClick={() => handleTempChat(false)}>
                    <span className={styles.tempChatMenuLabel}>{t('tempChatMenu.withPreset')}</span>
                    <span className={styles.tempChatMenuHint}>
                      {activePresetName || t('tempChatMenu.withPresetHint')}
                    </span>
                  </button>
                  <button type="button" className={styles.tempChatMenuItem} onClick={() => handleTempChat(true)}>
                    <span className={styles.tempChatMenuLabel}>{t('tempChatMenu.noPreset')}</span>
                    <span className={styles.tempChatMenuHint}>{t('tempChatMenu.noPresetHint')}</span>
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className={styles.accountBtn}
              onClick={handleLogout}
              title={t('logOutTitle')}
            >
              <span className={styles.accountName}>{accountLabel}</span>
              <LogOut size={13} strokeWidth={1.5} />
            </button>
          </div>
        </motion.header>

        <main className={styles.main}>
          <AnimatePresence mode="wait">
            {!settingsLoaded || (loading && items.length === 0) ? (
              <motion.div
                key={`loading-${skeletonLayout}`}
                className={skeletonLayout === 'compact' ? styles.compactList : styles.gridCards}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {Array.from({ length: skeletonCount }).map((_, i) => (
                  skeletonLayout === 'compact'
                    ? <SkeletonListItem key={i} index={i} />
                    : <SkeletonCard key={i} index={i} />
                ))}
              </motion.div>
            ) : error && items.length === 0 ? (
              <motion.div key="error" className={styles.errorState} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <p>{t('loadFailed')}</p>
                <button onClick={fetchChats} className={styles.primaryBtn} type="button">{t('tryAgain')}</button>
              </motion.div>
            ) : items.length === 0 ? (
              <EmptyState key="empty" />
            ) : (
              <motion.div
                key={`chats-${landingPageLayoutMode}`}
                className={landingPageLayoutMode === 'compact' ? styles.compactList : styles.gridCards}
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                {items.map((item) => (
                  landingPageLayoutMode === 'compact' ? (
                    <ChatListItem
                      key={getRecentChatKey(item)}
                      item={item}
                      onClick={() => handleChatClick(item)}
                      onDelete={
                        item.is_group
                          ? (item.chat_count === 1 ? () => handleDeleteChat(item) : undefined)
                          : () => (item.chat_count > 1 ? handleDeleteAllChats(item) : handleDeleteChat(item))
                      }
                    />
                  ) : (
                    <ChatCard
                      key={getRecentChatKey(item)}
                      item={item}
                      onClick={() => handleChatClick(item)}
                      onDelete={
                        item.is_group
                          ? (item.chat_count === 1 ? () => handleDeleteChat(item) : undefined)
                          : () => (item.chat_count > 1 ? handleDeleteAllChats(item) : handleDeleteChat(item))
                      }
                    />
                  )
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {hasMore && (
            <div ref={sentinelRef} className={styles.loadMoreSentinel}>
              {loadingMore && (
                <div className={styles.loadingMore}>
                  <Spinner size={16} />
                  <span>{t('loadingMore')}</span>
                </div>
              )}
            </div>
          )}
        </main>

        <motion.footer
          className={styles.footer}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.6 }}
        >
          <p>{t('footer')}</p>
        </motion.footer>
      </motion.div>
    </div>
  )
}
