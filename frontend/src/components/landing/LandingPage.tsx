import { useState, useEffect, useCallback, useMemo, useRef, memo, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence, type Variants } from 'motion/react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { MessageSquarePlus, MessageSquare, Trash2, Users, LogOut, FlaskConical, Gamepad2, Compass } from 'lucide-react'
import { Spinner } from '@/components/shared/Spinner'
import { chatsApi } from '@/api/chats'
import { imagesApi } from '@/api/images'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import { getCharacterAvatarLargeUrlById } from '@/lib/avatarUrls'
import { formatRelativeTime } from '@/lib/formatRelativeTime'
import { useStore } from '@/store'
import { useScrollGate } from '@/hooks/useScrollGate'
import { warmCharacterPalette } from '@/hooks/useCharacterTheme'
import { prefetchImages } from '@/lib/imageDecodeCache'
import LazyImage from '@/components/shared/LazyImage'
import {
  doesDeviceRotationNeedPermission,
  isDeviceRotationSupported,
  requestDeviceRotationPermission,
  subscribeDeviceRotation,
  type DeviceRotationSnapshot,
  type DeviceRotationPermissionState,
} from '@/lib/deviceRotation'
import type { CharacterPerspectiveLayer, GroupedRecentChat } from '@/types/api'
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

const PREFETCH_ROWS = 6

/**
 * Extract avatar image URLs for a list of items, mirroring the logic in
 * RecentChatAvatar but without the store hook. Used for prefetching.
 */
function getItemAvatarUrls(
  items: GroupedRecentChat[],
  characters: { id: string; image_id?: string | null }[],
): string[] {
  const urls: string[] = []
  for (const item of items) {
    const isGroup = item.is_group && item.group_character_ids && item.group_character_ids.length > 0
    if (isGroup) {
      for (const id of item.group_character_ids!.slice(0, 4)) {
        const char = characters.find((c) => c.id === id)
        const url = getCharacterAvatarLargeUrlById(id, char?.image_id ?? null)
        if (url) urls.push(url)
      }
    } else if (item.character_id) {
      const liveChar = characters.find((c) => c.id === item.character_id)
      const url = getCharacterAvatarLargeUrlById(
        item.character_id,
        liveChar?.image_id ?? item.character_image_id,
      )
      if (url) urls.push(url)
    }
  }
  return urls
}

function getPerspectiveLayers(value: unknown): CharacterPerspectiveLayer[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is CharacterPerspectiveLayer => {
        return Boolean(entry)
          && typeof entry === 'object'
          && typeof (entry as CharacterPerspectiveLayer).id === 'string'
          && typeof (entry as CharacterPerspectiveLayer).image_id === 'string'
      })
      .slice(0, 5)
      .map((entry) => ({
        ...entry,
        intensity: typeof entry.intensity === 'number' && Number.isFinite(entry.intensity)
          ? Math.max(0, Math.min(1.5, entry.intensity))
          : 0.6,
      }))
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const legacy = value as Record<string, string | undefined>
    return [
      legacy.background ? { id: 'background', image_id: legacy.background, label: 'Background', intensity: 0.15 } : null,
      legacy.framing ? { id: 'framing', image_id: legacy.framing, label: 'Framing', intensity: 1 } : null,
      legacy.subject ? { id: 'subject', image_id: legacy.subject, label: 'Subject', intensity: 0.6 } : null,
    ].filter(Boolean) as CharacterPerspectiveLayer[]
  }

  return []
}

function getPerspectiveLayerStyle(index: number, total: number, intensity: number): CSSProperties {
  const frontness = total <= 1 ? 1 : index / (total - 1)
  const clampedIntensity = Math.max(0, Math.min(1.5, intensity))

  // Motion, tilt, and Z-depth still depend on frontness — that's what creates
  // the parallax depth effect between layers.
  const motionX = clampedIntensity * (2 + frontness * 11)
  const motionY = clampedIntensity * (1.5 + frontness * 8.5)
  const motionDepth = clampedIntensity * (-1 + frontness * 4)
  const tiltAmount = clampedIntensity * (0.15 + frontness * 0.85)
  const originDepth = -12 + frontness * 58
  const hoverDepthTarget = clampedIntensity * (1 + frontness * 18)

  // Scale is derived from this layer's own motion amplitude, not directly from
  // its position in the parent stack. The layer is rendered at 116% size, giving
  // an intrinsic 16% overscan on each half-axis. Compute the minimum scale
  // needed to cover the worst-case translation + rotation for the smallest
  // supported card (CARD_MOBILE_MIN_WIDTH).
  const INTRINSIC_OVERSCAN = 0.16 // (116% - 100%) / 2 / 50%
  const halfCard = CARD_MOBILE_MIN_WIDTH / 2
  const halfDiagonal = halfCard * Math.sqrt(2)
  const maxTranslate = Math.hypot(motionX, motionY)
  const maxRotationOffset = (Math.abs(tiltAmount) * Math.PI / 180) * halfDiagonal
  const totalDisplacement = maxTranslate + maxRotationOffset
  const requiredOverscan = totalDisplacement / halfCard
  const functionalScale = (1 + requiredOverscan) / (1 + INTRINSIC_OVERSCAN)
  const baseScale = 1.015
  const hoverScale = Math.max(baseScale, Math.min(1.18, functionalScale))

  return {
    '--layer-origin-depth': `${originDepth}px`,
    '--layer-scale': baseScale.toFixed(3),
    '--layer-hover-depth-target': `${hoverDepthTarget}px`,
    '--layer-hover-scale': hoverScale.toFixed(3),
    '--layer-motion-x': `${motionX}px`,
    '--layer-motion-y': `${motionY}px`,
    '--layer-motion-depth': `${motionDepth}px`,
    '--layer-tilt-amount': `${tiltAmount}deg`,
    '--layer-tilt-amount-neg': `${-tiltAmount}deg`,
  } as CSSProperties
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
  const perspectiveLayers = item.character_perspective_layers?.length
    ? getPerspectiveLayers(item.character_perspective_layers)
    : getPerspectiveLayers(liveCharacter?.extensions?.landing_perspective_layers)
  const hasPerspectiveStack = variant === 'card'
    && !isGroup
    && perspectiveLayers.length >= 2

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
                  decoding="async"
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

  if (hasPerspectiveStack) {
    return (
      <div className={clsx(imageClassName, styles.perspectiveStack)}>
        {perspectiveLayers.map((layer, index) => (
          <img
            key={layer.id || layer.image_id}
            className={styles.perspectiveLayer}
            src={imagesApi.largeUrl(layer.image_id)}
            alt={index === perspectiveLayers.length - 1 ? item.character_name : ''}
            loading="lazy"
            decoding="async"
            draggable={false}
            style={{
              ...getPerspectiveLayerStyle(index, perspectiveLayers.length, layer.intensity),
              zIndex: index,
            }}
          />
        ))}
        <div className={styles.cardImageOverlay} />
      </div>
    )
  }

  return (
    <div className={imageClassName}>
      <LazyImage
        src={avatarUrl}
        alt={item.character_name}
        decoding="async"
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

function SkeletonCard(_props: { index: number }) {
  return (
    <div className={styles.skeletonCard}>
      <div className={styles.skeletonImage} />
      <div className={styles.skeletonContent}>
        <div className={styles.skeletonTitle} />
        <div className={styles.skeletonMeta} />
      </div>
    </div>
  )
}

function SkeletonListItem(_props: { index: number }) {
  return (
    <div className={styles.listSkeleton}>
      <div className={styles.listSkeletonAvatar} />
      <div className={styles.listSkeletonBody}>
        <div className={styles.listSkeletonTitle} />
        <div className={styles.listSkeletonMeta} />
      </div>
    </div>
  )
}

// Last-known landing layout + item count, persisted so the skeleton matches
// the real layout from the very first frame — before settings arrive from
// bootstrap. Without it the page sat blank until settingsLoaded, then showed
// a fixed 8 placeholders regardless of how many items would render.
const LANDING_HINT_KEY = '__lumiverse_landing_hint'
const SKELETON_MAX = 24
const CARD_MIN_WIDTH = 200
const CARD_GAP = 20
const CARD_MOBILE_BREAKPOINT = 600
const CARD_MOBILE_MIN_WIDTH = 140
const CARD_MOBILE_GAP = 12
const CARD_MOBILE_MAX_COLUMNS = 2
const COMPACT_MIN_WIDTH = 320
const COMPACT_GAP = 12
const COMPACT_ROW_ESTIMATE = 86
const VIRTUAL_OVERSCAN = 4
const MOBILE_PARALLAX_MAX_GAMMA_DELTA = 10
const MOBILE_PARALLAX_MAX_BETA_DELTA = 14

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

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

function getColumnCount(width: number, layout: 'cards' | 'compact') {
  if (width <= 0) return 1
  const mobileCards = layout === 'cards' && width <= CARD_MOBILE_BREAKPOINT
  const minWidth = layout === 'compact'
    ? COMPACT_MIN_WIDTH
    : mobileCards
      ? CARD_MOBILE_MIN_WIDTH
      : CARD_MIN_WIDTH
  const gap = getColumnGap(width, layout)
  const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)))
  return mobileCards ? Math.min(CARD_MOBILE_MAX_COLUMNS, columns) : columns
}

function getColumnGap(width: number, layout: 'cards' | 'compact') {
  if (layout === 'cards' && width <= CARD_MOBILE_BREAKPOINT) return CARD_MOBILE_GAP
  return layout === 'compact' ? COMPACT_GAP : CARD_GAP
}

function clampParallax(value: number): number {
  return Math.max(-1, Math.min(1, value))
}

function shouldUseMobileMotionParallax(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
  return Boolean(
    window.matchMedia?.('(hover: none)').matches ||
    window.matchMedia?.('(pointer: coarse)').matches
  )
}

function getPerspectiveTiltElements(root: HTMLElement): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>(`.${styles.perspectiveStack}`)
  const tilts = new Set<HTMLElement>()
  nodes.forEach((node) => {
    const tilt = node.closest<HTMLElement>(`.${styles.cardTilt}`)
    if (tilt) tilts.add(tilt)
  })
  return [...tilts]
}

function applyMobilePerspectiveParallax(root: HTMLElement, tiltX: number, tiltY: number): void {
  for (const tilt of getPerspectiveTiltElements(root)) {
    tilt.classList.add(styles.tilting, styles.mobileMotionTilting)
    tilt.style.transform = `rotateX(${tiltY * -4}deg) rotateY(${tiltX * 4}deg) scale3d(1.015,1.015,1.015)`
    tilt.style.setProperty('--tilt-x', String(tiltX))
    tilt.style.setProperty('--tilt-y', String(tiltY))
  }
}

function clearMobilePerspectiveParallax(root: HTMLElement): void {
  for (const tilt of getPerspectiveTiltElements(root)) {
    tilt.classList.remove(styles.mobileMotionTilting)
    if (!tilt.matches(':hover')) {
      tilt.classList.remove(styles.tilting)
      tilt.style.transform = ''
      tilt.style.removeProperty('--tilt-x')
      tilt.style.removeProperty('--tilt-y')
    }
  }
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

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  leaving: {
    opacity: 0,
    y: 10,
    scale: 0.985,
    transition: { duration: 0.22, ease: 'easeOut' },
  },
  exit: { opacity: 0 },
}

const CHAT_NAV_FADE_MS = 220

interface ChatCardProps {
  item: GroupedRecentChat
  animateEntry?: boolean
  onClick: (item: GroupedRecentChat) => void
  onDeleteChat: (item: GroupedRecentChat) => void
  onDeleteAllChats: (item: GroupedRecentChat) => void
}

const ChatCard = memo(function ChatCard({ item, animateEntry, onClick, onDeleteChat, onDeleteAllChats }: ChatCardProps) {
  const handleClick = useCallback(() => onClick(item), [onClick, item])
  const handleDelete = useMemo(() => {
    if (item.is_group && item.chat_count > 1) return undefined
    return () => {
      if (item.is_group) {
        onDeleteChat(item)
      } else if (item.chat_count > 1) {
        onDeleteAllChats(item)
      } else {
        onDeleteChat(item)
      }
    }
  }, [item, onDeleteChat, onDeleteAllChats])
  const { t } = useTranslation('landing')
  const tiltRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const rectRef = useRef<DOMRect | null>(null)
  const parallaxFrameRef = useRef<number | null>(null)
  const parallaxPointerRef = useRef<{ clientX: number; clientY: number } | null>(null)

  const isGroup = item.is_group && item.group_character_ids && item.group_character_ids.length > 0

  const applyParallax = useCallback((clientX: number, clientY: number) => {
    const tilt = tiltRef.current
    const card = cardRef.current
    const rect = rectRef.current
    if (!tilt || !card || !rect) return
    const mx = (clientX - rect.left) / rect.width
    const my = (clientY - rect.top) / rect.height
    const tiltX = (mx - 0.5) * 2
    const tiltY = (my - 0.5) * 2
    tilt.style.transform =
      `rotateX(${(my - 0.5) * -18}deg) rotateY(${(mx - 0.5) * 18}deg) scale3d(1.04,1.04,1.04)`
    tilt.style.setProperty('--tilt-x', String(tiltX))
    tilt.style.setProperty('--tilt-y', String(tiltY))
    card.style.setProperty('--shine-x', `${mx * 100}%`)
    card.style.setProperty('--shine-y', `${my * 100}%`)
  }, [])

  const scheduleParallax = useCallback((clientX: number, clientY: number) => {
    parallaxPointerRef.current = { clientX, clientY }
    if (parallaxFrameRef.current !== null) return
    parallaxFrameRef.current = requestAnimationFrame(() => {
      parallaxFrameRef.current = null
      const point = parallaxPointerRef.current
      if (!point) return
      applyParallax(point.clientX, point.clientY)
    })
  }, [applyParallax])

  useEffect(() => {
    return () => {
      if (parallaxFrameRef.current !== null) cancelAnimationFrame(parallaxFrameRef.current)
    }
  }, [])

  const handleMouseEnter = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const tilt = tiltRef.current
    if (!tilt) return
    rectRef.current = tilt.getBoundingClientRect()
    tilt.classList.add(styles.tilting)
    scheduleParallax(e.clientX, e.clientY)
  }, [scheduleParallax])

  const handleMouseMove = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (!rectRef.current) return
    scheduleParallax(e.clientX, e.clientY)
  }, [scheduleParallax])

  const handleMouseLeave = useCallback(() => {
    const tilt = tiltRef.current
    const card = cardRef.current
    if (!tilt || !card) return
    if (parallaxFrameRef.current !== null) cancelAnimationFrame(parallaxFrameRef.current)
    parallaxFrameRef.current = null
    parallaxPointerRef.current = null
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
        className={clsx(styles.card, animateEntry && styles.cardEntry, isGroup && styles.groupCard)}
      >
        {handleDelete && (
          <button
            type="button"
            className={styles.deleteBtn}
            onClick={(e) => {
              e.stopPropagation()
              handleDelete()
            }}
            title={!item.is_group && item.chat_count > 1 ? t('deleteAllChats') : t('deleteChat')}
          >
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        )}
        <button type="button" className={styles.cardBtn} onClick={handleClick}>
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
              {item.multiplayer && (
                <span className={styles.groupBadge} style={{ color: 'var(--lumiverse-accent, #6366f1)' }} title="Multiplayer">
                  <Gamepad2 size={10} strokeWidth={2} />
                </span>
              )}
              <span className={styles.cardTime}>{formatRelativeTime(item.updated_at)}</span>
            </div>
          </div>
        </button>
      </div>
    </div>
  )
})

const ChatListItem = memo(function ChatListItem({ item, animateEntry, onClick, onDeleteChat, onDeleteAllChats }: ChatCardProps) {
  const handleClick = useCallback(() => onClick(item), [onClick, item])
  const handleDelete = useMemo(() => {
    if (item.is_group && item.chat_count > 1) return undefined
    return () => {
      if (item.is_group) {
        onDeleteChat(item)
      } else if (item.chat_count > 1) {
        onDeleteAllChats(item)
      } else {
        onDeleteChat(item)
      }
    }
  }, [item, onDeleteChat, onDeleteAllChats])
  const { t } = useTranslation('landing')
  const isGroup = item.is_group && item.group_character_ids && item.group_character_ids.length > 0
  const displayName = getRecentChatDisplayName(item, t)
  const subtitle = getRecentChatSubtitle(item, t)

  return (
    <div className={clsx(styles.listItem, animateEntry && styles.listItemEntry, isGroup && styles.listItemGroup)}>
      {handleDelete && (
        <button
          type="button"
          className={styles.listDeleteBtn}
          onClick={(e) => {
            e.stopPropagation()
            handleDelete()
          }}
          title={t('deleteChat')}
        >
          <Trash2 size={14} strokeWidth={1.5} />
        </button>
      )}

      <button type="button" className={styles.listBtn} onClick={handleClick}>
        <RecentChatAvatar item={item} variant="compact" />
        <div className={styles.listBody}>
          <div className={styles.listTopRow}>
            <h3 className={styles.listName}>{displayName}</h3>
            <span className={styles.listTime}>{formatRelativeTime(item.updated_at)}</span>
          </div>

          <div className={styles.listBottomRow}>
            <p className={styles.listSubtitle}>{subtitle}</p>
            <div className={styles.listMeta}>
              {item.multiplayer && (
                <span className={styles.groupBadge} style={{ color: 'var(--lumiverse-accent, #6366f1)' }} title="Multiplayer">
                  <Gamepad2 size={10} strokeWidth={2} />
                </span>
              )}
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
})

interface VirtualRowProps {
  virtualRow: VirtualItem
  virtualColumns: number
  virtualGap: number
  rowItems: GroupedRecentChat[]
  layoutMode: 'cards' | 'compact'
  initialPageSize: number
  measureElement: (el: Element | null) => void
  onChatClick: (item: GroupedRecentChat) => void
  onDeleteChat: (item: GroupedRecentChat) => void
  onDeleteAllChats: (item: GroupedRecentChat) => void
}

function virtualRowPropsEqual(prev: VirtualRowProps, next: VirtualRowProps): boolean {
  if (prev.virtualRow.key !== next.virtualRow.key) return false
  if (prev.virtualRow.index !== next.virtualRow.index) return false
  if (prev.virtualColumns !== next.virtualColumns) return false
  if (prev.virtualGap !== next.virtualGap) return false
  if (prev.layoutMode !== next.layoutMode) return false
  if (prev.initialPageSize !== next.initialPageSize) return false
  if (prev.measureElement !== next.measureElement) return false
  if (prev.onChatClick !== next.onChatClick) return false
  if (prev.onDeleteChat !== next.onDeleteChat) return false
  if (prev.onDeleteAllChats !== next.onDeleteAllChats) return false
  if (prev.rowItems.length !== next.rowItems.length) return false
  for (let i = 0; i < prev.rowItems.length; i += 1) {
    if (prev.rowItems[i] !== next.rowItems[i]) return false
  }
  return true
}

const VirtualRow = memo(function VirtualRow({
  virtualRow,
  virtualColumns,
  virtualGap,
  rowItems,
  layoutMode,
  initialPageSize,
  measureElement,
  onChatClick,
  onDeleteChat,
  onDeleteAllChats,
}: VirtualRowProps) {
  const animateEntry = virtualRow.index * virtualColumns < initialPageSize
  return (
    <div
      ref={measureElement}
      data-index={virtualRow.index}
      className={styles.virtualRow}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${virtualColumns}, minmax(0, 1fr))`,
        gap: virtualGap,
        paddingBottom: virtualGap,
      }}
    >
      {rowItems.map((item) =>
        layoutMode === 'compact' ? (
          <ChatListItem
            key={getRecentChatKey(item)}
            item={item}
            animateEntry={animateEntry}
            onClick={onChatClick}
            onDeleteChat={onDeleteChat}
            onDeleteAllChats={onDeleteAllChats}
          />
        ) : (
          <ChatCard
            key={getRecentChatKey(item)}
            item={item}
            animateEntry={animateEntry}
            onClick={onChatClick}
            onDeleteChat={onDeleteChat}
            onDeleteAllChats={onDeleteAllChats}
          />
        ),
      )}
    </div>
  )
}, virtualRowPropsEqual)

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
  const hasGlobalWallpaper = useStore((s) => Boolean(s.wallpaper.global?.image_id))
  const accountLabel = authUser?.username || authUser?.name || t('account')

  const [items, setItems] = useState<GroupedRecentChat[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [creatingTempChat, setCreatingTempChat] = useState(false)
  const [tempChatMenuOpen, setTempChatMenuOpen] = useState(false)
  const [navigatingToChat, setNavigatingToChat] = useState(false)
  const [mobileMotionPermission, setMobileMotionPermission] = useState<DeviceRotationPermissionState>('unknown')
  const [showMobileMotionEnable, setShowMobileMotionEnable] = useState(false)
  const tempChatMenuRef = useRef<HTMLDivElement>(null)
  const tempChatMenuOpenedAt = useRef(0)
  const chatNavigationTimerRef = useRef<number | null>(null)

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
    const idleWindow = window as IdleWindow
    let cancelled = false
    const cleanup = () => {
      if (!cancelled) chatsApi.deleteTemporary().catch(() => {})
    }

    const usedIdleCallback = Boolean(idleWindow.requestIdleCallback)
    const handle = usedIdleCallback && idleWindow.requestIdleCallback
      ? idleWindow.requestIdleCallback(cleanup, { timeout: 2000 })
      : window.setTimeout(cleanup, 250)

    return () => {
      cancelled = true
      if (usedIdleCallback && idleWindow.cancelIdleCallback) {
        idleWindow.cancelIdleCallback(handle)
      } else {
        window.clearTimeout(handle)
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (chatNavigationTimerRef.current !== null) {
        window.clearTimeout(chatNavigationTimerRef.current)
      }
    }
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
  const mainRef = useRef<HTMLElement>(null)
  const virtualContainerRef = useRef<HTMLDivElement | null>(null)
  const [mainWidth, setMainWidth] = useState(() => Math.min(1400, Math.max(320, window.innerWidth - 64)))
  const [virtualScrollMargin, setVirtualScrollMargin] = useState(0)

  useScrollGate(scrollRef)

  useEffect(() => {
    setShowMobileMotionEnable(
      landingPageLayoutMode === 'cards' &&
      shouldUseMobileMotionParallax() &&
      isDeviceRotationSupported() &&
      doesDeviceRotationNeedPermission()
    )
  }, [landingPageLayoutMode])

  useEffect(() => {
    const root = scrollRef.current
    if (!root || landingPageLayoutMode !== 'cards' || !shouldUseMobileMotionParallax()) return

    let frame = 0
    let baselineBeta: number | null = null
    let baselineGamma: number | null = null
    let nextTiltX = 0
    let nextTiltY = 0

    const scheduleApply = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        applyMobilePerspectiveParallax(root, nextTiltX, nextTiltY)
      })
    }

    const handleRotation = (snapshot: DeviceRotationSnapshot) => {
      setMobileMotionPermission(snapshot.permission)
      if (snapshot.hasReading) setShowMobileMotionEnable(false)

      const orientation = snapshot.orientation
      if (!orientation || orientation.beta === null || orientation.gamma === null) return

      baselineBeta ??= orientation.beta
      baselineGamma ??= orientation.gamma

      nextTiltX = clampParallax((orientation.gamma - baselineGamma) / MOBILE_PARALLAX_MAX_GAMMA_DELTA)
      nextTiltY = clampParallax((orientation.beta - baselineBeta) / MOBILE_PARALLAX_MAX_BETA_DELTA)
      scheduleApply()
    }

    const unsubscribe = subscribeDeviceRotation(handleRotation, { emitCurrent: true })

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      unsubscribe()
      clearMobilePerspectiveParallax(root)
    }
  }, [landingPageLayoutMode, items.length])

  const handleEnableMobileMotion = useCallback(async () => {
    try {
      const result = await requestDeviceRotationPermission({ includeMotion: false })
      setMobileMotionPermission(result.state)
      if (result.state === 'granted') setShowMobileMotionEnable(false)
    } catch {
      setMobileMotionPermission('prompt')
    }
  }, [])

  const updateVirtualScrollMargin = useCallback(() => {
    const scrollEl = scrollRef.current
    const virtualEl = virtualContainerRef.current
    if (!scrollEl || !virtualEl) return
    const next = virtualEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
    setVirtualScrollMargin(next)
  }, [])

  useEffect(() => {
    const el = mainRef.current
    if (!el) return

    let frame = 0
    const update = () => {
      frame = 0
      setMainWidth(el.clientWidth)
      updateVirtualScrollMargin()
    }
    const scheduleUpdate = () => {
      if (frame) return
      frame = requestAnimationFrame(update)
    }

    scheduleUpdate()
    const observer = new ResizeObserver(scheduleUpdate)
    observer.observe(el)
    window.addEventListener('resize', scheduleUpdate)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [updateVirtualScrollMargin])

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

  const navigateToChat = useCallback((chatId: string) => {
    if (chatNavigationTimerRef.current !== null) return

    setNavigatingToChat(true)

    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion) {
      navigate(`/chat/${chatId}`)
      return
    }

    chatNavigationTimerRef.current = window.setTimeout(() => {
      chatNavigationTimerRef.current = null
      navigate(`/chat/${chatId}`)
    }, CHAT_NAV_FADE_MS)
  }, [navigate])

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
        navigateToChat(item.latest_chat_id)
        return
      }

      if (item.chat_count === 1) {
        navigateToChat(item.latest_chat_id)
        return
      }

      openModal('chatPicker', {
        characterId: item.character_id,
        characterName: item.character_name,
        onSelect: (chatId: string) => navigateToChat(chatId)
      })
    },
    [navigateToChat, openModal, t]
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
      navigateToChat(chat.id)
    } catch (err: any) {
      console.error('[Lumiverse] Error creating temporary chat:', err)
      setCreatingTempChat(false)
    }
  }, [creatingTempChat, navigateToChat])

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
  const virtualLayout = landingPageLayoutMode === 'compact' ? 'compact' : 'cards'
  const virtualGap = getColumnGap(mainWidth, virtualLayout)
  const virtualColumns = getColumnCount(mainWidth, virtualLayout)
  const virtualRowCount = Math.ceil(items.length / virtualColumns)
  const virtualColumnWidth = Math.max(1, (mainWidth - virtualGap * (virtualColumns - 1)) / virtualColumns)
  const virtualRowEstimate = virtualLayout === 'compact'
    ? COMPACT_ROW_ESTIMATE + virtualGap
    : Math.ceil(virtualColumnWidth * (4 / 3)) + virtualGap

  const chatVirtualizer = useVirtualizer({
    count: virtualRowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => virtualRowEstimate,
    overscan: VIRTUAL_OVERSCAN,
    anchorTo: 'start',
    scrollMargin: virtualScrollMargin,
    directDomUpdates: true,
    useFlushSync: false,
    getItemKey: (index) => {
      const start = index * virtualColumns
      return items.slice(start, start + virtualColumns).map(getRecentChatKey).join('|') || index
    },
  })

  useEffect(() => {
    chatVirtualizer.measure()
    updateVirtualScrollMargin()
  }, [chatVirtualizer, updateVirtualScrollMargin, virtualColumns, virtualRowEstimate, virtualLayout])

  // Prefetch avatar images for rows near the visible viewport so they're
  // already decoded when the virtualizer scrolls them into view.
  const characters = useStore((s) => s.characters)
  const virtualItems = chatVirtualizer.getVirtualItems()
  const visStart = virtualItems.length > 0 ? virtualItems[0].index : -1
  const visEnd = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1
  useEffect(() => {
    if (visStart < 0 || visEnd < 0 || items.length === 0) return
    const startRow = Math.max(0, visStart - PREFETCH_ROWS)
    const endRow = Math.min(virtualRowCount - 1, visEnd + PREFETCH_ROWS)
    const startItem = startRow * virtualColumns
    const endItem = Math.min(items.length, (endRow + 1) * virtualColumns)
    const urls = getItemAvatarUrls(items.slice(startItem, endItem), characters)
    if (urls.length > 0) prefetchImages(urls)
  }, [visStart, visEnd, items, virtualColumns, virtualRowCount, characters])

  const setVirtualContainerRef = useCallback((node: HTMLDivElement | null) => {
    virtualContainerRef.current = node
    chatVirtualizer.containerRef(node)
    updateVirtualScrollMargin()
  }, [chatVirtualizer, updateVirtualScrollMargin])

  return (
    <div className={styles.page}>
      <div className={styles.container} ref={scrollRef} data-component="LandingPage">
      {!hasGlobalWallpaper && (
        <>
          <div className={styles.bg}>
            <div className={clsx(styles.bgGlow, styles.bgGlow1)} />
            <div className={clsx(styles.bgGlow, styles.bgGlow2)} />
            <div className={clsx(styles.bgGlow, styles.bgGlow3)} />
          </div>

          <div className={styles.grid} />
        </>
      )}

      <motion.div
        className={styles.content}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
      >
        <header className={styles.header}>
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
            {showMobileMotionEnable && mobileMotionPermission !== 'denied' && (
              <button
                type="button"
                className={styles.accountBtn}
                onClick={handleEnableMobileMotion}
                title="Enable motion parallax"
              >
                <span className={styles.accountName}>Motion</span>
                <Compass size={13} strokeWidth={1.5} />
              </button>
            )}
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
        </header>

        <main className={styles.main} ref={mainRef}>
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
                className={clsx(
                  styles.virtualChats,
                  navigatingToChat && styles.chatsLeaving
                )}
                ref={setVirtualContainerRef}
                variants={containerVariants}
                initial="hidden"
                animate={navigatingToChat ? 'leaving' : 'visible'}
                exit="exit"
              >
                {chatVirtualizer.getVirtualItems().map((virtualRow) => {
                  const start = virtualRow.index * virtualColumns
                  return (
                    <VirtualRow
                      key={virtualRow.key}
                      virtualRow={virtualRow}
                      virtualColumns={virtualColumns}
                      virtualGap={virtualGap}
                      rowItems={items.slice(start, start + virtualColumns)}
                      layoutMode={landingPageLayoutMode}
                      initialPageSize={landingPageChatsDisplayed}
                      measureElement={chatVirtualizer.measureElement}
                      onChatClick={handleChatClick}
                      onDeleteChat={handleDeleteChat}
                      onDeleteAllChats={handleDeleteAllChats}
                    />
                  )
                })}
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
      </motion.div>
    </div>
  </div>
)
}
