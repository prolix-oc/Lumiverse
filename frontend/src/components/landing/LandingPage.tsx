import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import { motion, AnimatePresence } from 'motion/react'
import { RefreshCw, MessageSquarePlus, Loader2, MessageSquare, Trash2 } from 'lucide-react'
import { chatsApi } from '@/api/chats'
import { charactersApi } from '@/api/characters'
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
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.04 },
  },
  exit: { opacity: 0 },
}

const cardVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.95 },
  visible: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
}

interface ChatCardProps {
  item: GroupedRecentChat
  onClick: () => void
  onDelete?: () => void
}

function ChatCard({ item, onClick, onDelete }: ChatCardProps) {
  const avatarUrl = item.character_id
    ? charactersApi.avatarUrl(item.character_id)
    : null

  return (
    <motion.div
      className={styles.card}
      variants={cardVariants}
      whileHover={{ y: -3 }}
      transition={{ duration: 0.2 }}
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
    </motion.div>
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
          <div className={styles.headerLeft}>
            <div className={styles.logo}>
              <div className={styles.logoIcon}>
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
                <span>Continue your story</span>
              </div>
            </div>
          </div>

          <div className={styles.headerRight}>
            <motion.button
              className={styles.headerBtn}
              onClick={handleNewChat}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              type="button"
              title="New chat"
            >
              <MessageSquarePlus size={16} strokeWidth={1.5} />
            </motion.button>
            <motion.button
              className={styles.headerBtn}
              onClick={fetchChats}
              disabled={loading}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              type="button"
            >
              <RefreshCw size={16} strokeWidth={1.5} className={loading ? styles.spin : ''} />
            </motion.button>
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
