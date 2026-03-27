import { useState, useEffect, useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from 'react-router'
import { motion, AnimatePresence } from 'motion/react'
import { MessageSquarePlus, Loader2, MessageSquare, Trash2 } from 'lucide-react'
import { chatsApi } from '@/api/chats'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import { getCharacterAvatarLargeUrlById } from '@/lib/avatarUrls'
import { useStore } from '@/store'
import { useScrollGate } from '@/hooks/useScrollGate'
import LazyImage from '@/components/shared/LazyImage'
import type { GroupedRecentChat } from '@/types/api'
import styles from './LandingPage.module.css'
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

function SkeletonCard({ index }: { index: number }) {
  return (
    <motion.div
      className={styles.skeletonCard}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
    >
      <div className={styles.skeletonImage} />
      <div className={styles.skeletonContent}>
        <div className={styles.skeletonTitle} />
        <div className={styles.skeletonMeta} />
      </div>
    </motion.div>
  )
}

function EmptyState() {
  return (
    <motion.div
      className={styles.emptyState}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className={styles.emptyIcon}>
        <MessageSquarePlus size={48} strokeWidth={1} />
      </div>
      <h3>No recent chats</h3>
      <p>Start a conversation with a character to begin</p>
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
  const characters = useStore((s) => s.characters)
  const tiltRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const rectRef = useRef<DOMRect | null>(null)

  const liveCharacter = item.character_id
    ? characters.find((entry) => entry.id === item.character_id) ?? null
    : null
  const avatarUrl = item.character_id
    ? getCharacterAvatarLargeUrlById(
        item.character_id,
        liveCharacter?.image_id ?? item.character_image_id
      )
    : null

  const handleMouseEnter = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const tilt = tiltRef.current
    const card = cardRef.current
    if (!tilt || !card) return
    rectRef.current = tilt.getBoundingClientRect()
    tilt.classList.add(styles.tilting)
    const rect = rectRef.current
    const mx = (e.clientX - rect.left) / rect.width
    const my = (e.clientY - rect.top) / rect.height
    tilt.style.transform =
      `rotateX(${(my - 0.5) * -18}deg) rotateY(${(mx - 0.5) * 18}deg) scale3d(1.04,1.04,1.04)`
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
    tilt.style.transform =
      `rotateX(${(my - 0.5) * -18}deg) rotateY(${(mx - 0.5) * 18}deg) scale3d(1.04,1.04,1.04)`
    card.style.setProperty('--shine-x', `${mx * 100}%`)
    card.style.setProperty('--shine-y', `${my * 100}%`)
  }, [])

  const handleMouseLeave = useCallback(() => {
    const tilt = tiltRef.current
    const card = cardRef.current
    if (!tilt || !card) return
    tilt.classList.remove(styles.tilting)
    tilt.style.transform = ''
    card.style.removeProperty('--shine-x')
    card.style.removeProperty('--shine-y')
    rectRef.current = null
  }, [])

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
        className={styles.card}
      >
        {onDelete && (
          <button
            type="button"
            className={styles.deleteBtn}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            title="Delete chat"
          >
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        )}
        <button type="button" className={styles.cardBtn} onClick={onClick}>
          <div className={styles.cardImage}>
            <LazyImage
              src={avatarUrl}
              alt={item.character_name}
              fallback={
                <div className={styles.cardAvatarFallback}>
                  {item.character_name?.[0]?.toUpperCase() || '?'}
                </div>
              }
            />
            <div className={styles.cardImageOverlay} />
          </div>
          <div className={styles.cardContent}>
            <h3 className={styles.cardName}>{item.character_name}</h3>
            <div className={styles.cardMeta}>
              {item.chat_count > 1 && (
                <span className={styles.chatCountBadge}>
                  <MessageSquare size={10} strokeWidth={2} />
                  {item.chat_count}
                </span>
              )}
              <span className={styles.cardTime}>{formatRelativeTime(item.updated_at)}</span>
            </div>
          </div>
        </button>
      </div>
    </div>
  )
}

export default function LandingPage() {
  const navigate = useNavigate()
  const landingPageChatsDisplayed = useStore((s) => s.landingPageChatsDisplayed)
  const openModal = useStore((s) => s.openModal)

  const [items, setItems] = useState<GroupedRecentChat[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)

  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useScrollGate(scrollRef)

  const fetchChats = useCallback(async () => {
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
  }, [landingPageChatsDisplayed])

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

  // Listen for chat deletions (from command palette, chat view, etc.) and refresh
  useEffect(() => {
    return wsClient.on(EventType.CHAT_DELETED, () => {
      fetchChats()
    })
  }, [fetchChats])

  // Infinite scroll: load more when sentinel is visible
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
      // If the character only has 1 chat, just jump straight in
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
    [navigate, openModal]
  )

  const handleDeleteChat = useCallback(
    (item: GroupedRecentChat) => {
      openModal('confirm', {
        title: 'Delete Chat',
        message: `This will permanently delete your chat with ${item.character_name}. This action cannot be undone.`,
        variant: 'danger',
        confirmText: 'Delete',
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
    [openModal]
  )

  const handleNewChat = useCallback(() => {
    navigate('/characters')
  }, [navigate])

  const hasMore = items.length < total

  return (
    <div className={styles.container} ref={scrollRef}>
      {/* Ambient background */}
      <div className={styles.bg}>
        <div className={clsx(styles.bgGlow, styles.bgGlow1)} />
        <div className={clsx(styles.bgGlow, styles.bgGlow2)} />
        <div className={clsx(styles.bgGlow, styles.bgGlow3)} />
      </div>

      {/* Grid pattern */}
      <div className={styles.grid} />

      {/* Main content */}
      <motion.div
        className={styles.content}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
      >
        {/* Header */}
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
              <h1>Lumiverse</h1>
              <button type="button" className={styles.taglineBtn} onClick={handleNewChat}>
                <span>Continue your story</span>
                <MessageSquarePlus size={13} strokeWidth={1.5} />
              </button>
            </div>
          </div>
        </motion.header>

        {/* Main grid */}
        <main className={styles.main}>
          <AnimatePresence mode="wait">
            {loading && items.length === 0 ? (
              <motion.div key="loading" className={styles.gridCards} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {Array.from({ length: 8 }).map((_, i) => (
                  <SkeletonCard key={i} index={i} />
                ))}
              </motion.div>
            ) : error && items.length === 0 ? (
              <motion.div key="error" className={styles.errorState} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <p>Failed to load chats</p>
                <button onClick={fetchChats} className={styles.primaryBtn} type="button">Try Again</button>
              </motion.div>
            ) : items.length === 0 ? (
              <EmptyState key="empty" />
            ) : (
              <motion.div key="chats" className={styles.gridCards} variants={containerVariants} initial="hidden" animate="visible" exit="exit">
                {items.map((item) => (
                  <ChatCard
                    key={item.character_id}
                    item={item}
                    onClick={() => handleChatClick(item)}
                    onDelete={item.chat_count === 1 ? () => handleDeleteChat(item) : undefined}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Infinite scroll sentinel */}
          {hasMore && (
            <div ref={sentinelRef} className={styles.loadMoreSentinel}>
              {loadingMore && (
                <div className={styles.loadingMore}>
                  <Loader2 size={16} className={styles.spin} />
                  <span>Loading more chats...</span>
                </div>
              )}
            </div>
          )}
        </main>

        {/* Footer */}
        <motion.footer
          className={styles.footer}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.6 }}
        >
          <p>Select a character to continue your journey</p>
        </motion.footer>
      </motion.div>
    </div>
  )
}
