import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { X, EyeOff, Columns2, Rows2, Wrench, AlertTriangle } from 'lucide-react'
import { useStore } from '@/store'
import { generateApi } from '@/api/generate'
import { getCharacterAvatarThumbUrlById } from '@/lib/avatarUrls'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import type { ChatHeadEntry } from '@/types/store'
import styles from './ChatHeads.module.css'

const PAD = 12
const DRAG_THRESHOLD = 5
const LONG_PRESS_MS = 500

// ── Helpers: percentage <-> pixel ──

function pctToPixel(pct: number, viewport: number, size: number): number {
  if (pct < 0) return -1
  return Math.max(PAD, Math.min(pct * viewport, viewport - size - PAD))
}

function pixelToPct(px: number, viewport: number): number {
  return viewport > 0 ? px / viewport : 0
}

// ═════════════════════════════════════════════════════════════════════════════

export default function ChatHeads() {
  const chatHeads = useStore((s) => s.chatHeads)
  const activeChatId = useStore((s) => s.activeChatId)
  const savedPos = useStore((s) => s.chatHeadsPosition)
  const setChatHeadsPosition = useStore((s) => s.setChatHeadsPosition)
  const removeChatHead = useStore((s) => s.removeChatHead)
  const enabled = useStore((s) => s.chatHeadsEnabled)
  const headSize = useStore((s) => s.chatHeadsSize)
  const direction = useStore((s) => s.chatHeadsDirection)
  const opacity = useStore((s) => s.chatHeadsOpacity)
  const setSetting = useStore((s) => s.setSetting)
  const navigate = useNavigate()

  const [pos, setPos] = useState({ x: -1, y: -1 })
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const isDragging = useRef(false)
  const offset = useRef({ x: 0, y: 0 })
  const dragStartPos = useRef({ x: 0, y: 0 })
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Gravitational trail refs ──
  const posRef = useRef({ x: -1, y: -1 })
  const headOffsetsRef = useRef<{ x: number; y: number }[]>([])
  const gravityLastPosRef = useRef({ x: 0, y: 0 })
  const gravityRafRef = useRef(0)

  const reconcileChatHeads = useStore((s) => s.reconcileChatHeads)

  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null)

  // On mount, reconcile persisted heads against backend active generations
  useEffect(() => { reconcileChatHeads() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Filter out the chat the user is currently viewing
  const visible = chatHeads.filter((h) => h.chatId !== activeChatId)

  // ── Exit animation: keep departing heads rendered until animation finishes ──
  const [exitingHeads, setExitingHeads] = useState<ChatHeadEntry[]>([])
  const prevVisibleRef = useRef<ChatHeadEntry[]>([])
  const exitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useLayoutEffect(() => {
    const currIds = new Set(visible.map((h) => h.chatId))
    const exitIds = new Set(exitingHeads.map((h) => h.chatId))
    const newlyExiting = prevVisibleRef.current.filter(
      (h) => !currIds.has(h.chatId) && !exitIds.has(h.chatId)
    )
    if (newlyExiting.length > 0) {
      setExitingHeads((prev) => [...prev, ...newlyExiting])
      for (const head of newlyExiting) {
        const timer = setTimeout(() => {
          exitTimersRef.current.delete(head.chatId)
          setExitingHeads((prev) => prev.filter((h) => h.chatId !== head.chatId))
        }, 260) // headExit animation is 240ms + buffer
        exitTimersRef.current.set(head.chatId, timer)
      }
    }
    prevVisibleRef.current = [...visible]
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    for (const timer of exitTimersRef.current.values()) clearTimeout(timer)
  }, [])

  const displayed = useMemo(() => {
    let gi = 0
    const exiting = exitingHeads.filter((e) => !visible.some((v) => v.chatId === e.chatId))
    return [
      ...visible.map((h) => ({ head: h, gravityIndex: gi++, isExiting: false })),
      ...exiting.map((h) => ({ head: h, gravityIndex: -1, isExiting: true })),
    ]
  }, [visible, exitingHeads])

  // Estimate container size for clamping
  const getContainerSize = useCallback(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      return { w: rect.width, h: rect.height }
    }
    const gap = 8
    const pad = 12
    const count = visible.length || 1
    if (direction === 'row') {
      return { w: count * headSize + (count - 1) * gap + pad * 2, h: headSize + pad * 2 }
    }
    return { w: headSize + pad * 2, h: count * headSize + (count - 1) * gap + pad * 2 }
  }, [visible.length, headSize, direction])

  const clampPos = useCallback(
    (x: number, y: number) => {
      const { w, h } = getContainerSize()
      return {
        x: Math.max(PAD, Math.min(x, window.innerWidth - w - PAD)),
        y: Math.max(PAD, Math.min(y, window.innerHeight - h - PAD)),
      }
    },
    [getContainerSize]
  )

  // Convert percentage position to pixels on mount / when visibility changes
  useEffect(() => {
    if (visible.length === 0) return
    const { w, h } = getContainerSize()
    let x = pctToPixel(savedPos.xPct, window.innerWidth, w)
    let y = pctToPixel(savedPos.yPct, window.innerHeight, h)
    if (x < 0 || y < 0) {
      // Default: right edge, vertically centered
      x = window.innerWidth - w - PAD
      y = Math.round((window.innerHeight - h) / 2)
    }
    setPos(clampPos(x, y))
  }, [visible.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-clamp on window resize (handles desktop ↔ mobile)
  useEffect(() => {
    if (visible.length === 0) return
    const onResize = () => {
      const { w, h } = getContainerSize()
      // Re-derive from percentages so position scales with viewport
      let x = pctToPixel(savedPos.xPct, window.innerWidth, w)
      let y = pctToPixel(savedPos.yPct, window.innerHeight, h)
      if (x < 0 || y < 0) {
        x = window.innerWidth - w - PAD
        y = Math.round((window.innerHeight - h) / 2)
      }
      setPos(clampPos(x, y))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [visible.length, clampPos, getContainerSize, savedPos])

  // ── Save position as percentages ──
  const savePosition = useCallback(
    (px: { x: number; y: number }) => {
      setChatHeadsPosition({
        xPct: pixelToPct(px.x, window.innerWidth),
        yPct: pixelToPct(px.y, window.innerHeight),
      })
    },
    [setChatHeadsPosition]
  )

  // Sync posRef with state for gravity calculations
  useEffect(() => { posRef.current = pos }, [pos.x, pos.y]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Gravitational chain-following effect ──
  const startGravity = useCallback(() => {
    if (gravityRafRef.current) return
    gravityLastPosRef.current = { ...posRef.current }

    const tick = () => {
      const currentPos = posRef.current
      const delta = {
        x: currentPos.x - gravityLastPosRef.current.x,
        y: currentPos.y - gravityLastPosRef.current.y,
      }
      gravityLastPosRef.current = { ...currentPos }

      const offsets = headOffsetsRef.current
      const container = containerRef.current
      if (!container) { gravityRafRef.current = 0; return }

      const heads = container.querySelectorAll<HTMLElement>('[data-head-idx]')
      while (offsets.length < heads.length) offsets.push({ x: 0, y: 0 })
      if (offsets.length > heads.length) offsets.length = heads.length

      if (offsets.length <= 1) {
        gravityRafRef.current = isDragging.current ? requestAnimationFrame(tick) : 0
        return
      }

      const SPRING = 0.25
      const EPSILON = 0.5

      offsets[0] = { x: 0, y: 0 }

      let moving = false
      for (let i = 1; i < offsets.length; i++) {
        // Counteract container movement — this head hasn't caught up yet
        offsets[i].x -= delta.x
        offsets[i].y -= delta.y

        // Chain spring: each head follows the one before it
        const target = offsets[i - 1]
        offsets[i].x += (target.x - offsets[i].x) * SPRING
        offsets[i].y += (target.y - offsets[i].y) * SPRING

        if (Math.abs(offsets[i].x) > EPSILON || Math.abs(offsets[i].y) > EPSILON) {
          moving = true
        }
      }

      // Apply CSS transforms directly to DOM
      heads.forEach((el) => {
        const idx = parseInt(el.dataset.headIdx || '0', 10)
        if (idx > 0 && offsets[idx]) {
          el.style.transform = `translate(${offsets[idx].x}px, ${offsets[idx].y}px)`
        }
      })

      if (isDragging.current || moving) {
        gravityRafRef.current = requestAnimationFrame(tick)
      } else {
        heads.forEach((el) => { el.style.transform = '' })
        gravityRafRef.current = 0
      }
    }

    gravityRafRef.current = requestAnimationFrame(tick)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (gravityRafRef.current) cancelAnimationFrame(gravityRafRef.current) }, [])

  // ── Drag handlers ──

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      isDragging.current = false
      dragging.current = true
      dragStartPos.current = { x: e.clientX, y: e.clientY }
      offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      e.preventDefault()

      // Start long-press timer for mobile context menu
      if (longPressTimer.current) clearTimeout(longPressTimer.current)
      longPressTimer.current = setTimeout(() => {
        if (!isDragging.current && dragging.current) {
          dragging.current = false
          navigator.vibrate?.(50)
          setContextMenu({ x: e.clientX, y: e.clientY })
        }
      }, LONG_PRESS_MS)
    },
    [pos]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return
      if (!isDragging.current) {
        const dx = Math.abs(e.clientX - dragStartPos.current.x)
        const dy = Math.abs(e.clientY - dragStartPos.current.y)
        if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return
        isDragging.current = true
        // Cancel long-press if dragging
        if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null }
        // Start gravitational following for trailing heads
        const headEls = containerRef.current?.querySelectorAll('[data-head-idx]')
        headOffsetsRef.current = Array.from({ length: headEls?.length || 0 }, () => ({ x: 0, y: 0 }))
        startGravity()
      }
      const raw = { x: e.clientX - offset.current.x, y: e.clientY - offset.current.y }
      const clamped = clampPos(raw.x, raw.y)
      posRef.current = clamped
      setPos(clamped)
    },
    [clampPos, startGravity]
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null }
      if (!dragging.current) return
      dragging.current = false
      if (isDragging.current) {
        e.preventDefault()
        e.stopPropagation()
        requestAnimationFrame(() => {
          setPos((prev) => { savePosition(prev); return prev })
        })
        isDragging.current = false
      } else {
        isDragging.current = false
        const el = document.elementFromPoint(e.clientX, e.clientY)
        if (el) {
          const headEl = (el as HTMLElement).closest?.('[data-chat-id]') as HTMLElement | null
          if (headEl?.dataset.chatId) {
            const chatId = headEl.dataset.chatId
            const clickedHead = useStore.getState().chatHeads.find((h) => h.chatId === chatId)
            if (clickedHead && (clickedHead.status === 'completed' || clickedHead.status === 'stopped' || clickedHead.status === 'error')) {
              useStore.getState().deleteChatHead(chatId)
              generateApi.acknowledge(chatId).catch(() => {})
            }
            navigate(`/chat/${chatId}`)
          }
        }
      }
    },
    [savePosition, navigate]
  )

  // Desktop right-click context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  // ── Context menu items ──
  const contextMenuItems = useMemo<ContextMenuEntry[]>(() => [
    {
      key: 'dir-col',
      label: 'Vertical',
      icon: <Columns2 size={14} />,
      active: direction === 'column',
      onClick: () => setSetting('chatHeadsDirection', 'column'),
    },
    {
      key: 'dir-row',
      label: 'Horizontal',
      icon: <Rows2 size={14} />,
      active: direction === 'row',
      onClick: () => setSetting('chatHeadsDirection', 'row'),
    },
    { key: 'div-1', type: 'divider' as const },
    {
      key: 'size-sm',
      label: 'Small (36px)',
      active: headSize <= 38,
      onClick: () => setSetting('chatHeadsSize', 36),
    },
    {
      key: 'size-md',
      label: 'Medium (48px)',
      active: headSize > 38 && headSize <= 54,
      onClick: () => setSetting('chatHeadsSize', 48),
    },
    {
      key: 'size-lg',
      label: 'Large (64px)',
      active: headSize > 54,
      onClick: () => setSetting('chatHeadsSize', 64),
    },
    { key: 'div-2', type: 'divider' as const },
    {
      key: 'opacity',
      type: 'custom' as const,
      content: (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', fontSize: 12.5, color: 'var(--lumiverse-text-muted)' }}>
          Opacity
          <input
            type="range"
            min={20}
            max={100}
            step={5}
            value={Math.round(opacity * 100)}
            onChange={(e) => setSetting('chatHeadsOpacity', parseInt(e.target.value, 10) / 100)}
            style={{ flex: 1, accentColor: 'var(--lumiverse-primary)' }}
          />
        </label>
      ),
    },
    { key: 'div-3', type: 'divider' as const },
    {
      key: 'hide',
      label: 'Hide chat heads',
      icon: <EyeOff size={14} />,
      onClick: () => setSetting('chatHeadsEnabled', false),
    },
  ], [direction, headSize, opacity, setSetting])

  if (!enabled || displayed.length === 0) return null

  const containerClass = [
    styles.container,
    isDragging.current ? styles.containerDragging : '',
  ]
    .filter(Boolean)
    .join(' ')

  return createPortal(
    <>
      <div
        ref={containerRef}
        className={containerClass}
        style={{
          left: pos.x,
          top: pos.y,
          flexDirection: direction,
          opacity,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onContextMenu={handleContextMenu}
      >
        {displayed.map((item) => (
          <ChatHeadBubble key={item.head.chatId} head={item.head} size={headSize} index={item.gravityIndex} isExiting={item.isExiting} />
        ))}
      </div>
      <ContextMenu
        position={contextMenu}
        items={contextMenuItems}
        onClose={() => setContextMenu(null)}
      />
    </>,
    document.body
  )
}

// ── Individual chat head ──

function ChatHeadBubble({ head, size, index, isExiting }: { head: ChatHeadEntry; size: number; index: number; isExiting?: boolean }) {
  const isActive =
    head.status === 'assembling' ||
    head.status === 'council' ||
    head.status === 'reasoning' ||
    head.status === 'streaming'
  const isCompleted = head.status === 'completed' || head.status === 'stopped'
  const isError = head.status === 'error'
  const avatarUrl = head.avatarUrl || getCharacterAvatarThumbUrlById(head.characterId)

  const headClass = [styles.head, isActive ? styles.headActive : '', isExiting ? styles.headExiting : '']
    .filter(Boolean)
    .join(' ')

  const isDimmed = head.status === 'assembling'

  return (
    <div className={headClass} data-chat-id={head.chatId} data-head-idx={index >= 0 ? index : undefined} style={{ width: size, height: size, pointerEvents: isExiting ? 'none' : undefined }}>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={head.characterName}
          className={`${styles.avatar} ${isDimmed ? styles.avatarDimmed : ''}`}
          style={{ width: size, height: size }}
          draggable={false}
        />
      ) : (
        <div className={`${styles.avatarFallback} ${isDimmed ? styles.avatarDimmed : ''}`} style={{ width: size, height: size, fontSize: size * 0.38 }}>
          {head.characterName.charAt(0).toUpperCase()}
        </div>
      )}

      <StatusBadge status={head.status} />

      {/* Assembly: spinning ring around avatar border */}
      {head.status === 'assembling' && (
        <div className={styles.assemblyRing} />
      )}

      {/* Council: wrench inside speech bubble (top-left) */}
      {(head.status === 'council' || head.status === 'council_failed') && (
        <div className={styles.speechBubble}>
          <CouncilBubbleSvg failed={head.status === 'council_failed'} />
          {head.status === 'council' ? (
            <Wrench className={styles.wrenchIcon} />
          ) : (
            <AlertTriangle className={styles.wrenchIcon} />
          )}
        </div>
      )}

      {/* Reasoning: thought cloud (top-right) */}
      {head.status === 'reasoning' && (
        <div className={styles.thoughtCloud}>
          <ThoughtCloudSvg />
          <AnimatedDots />
        </div>
      )}

      {/* Streaming: speech bubble with dots (top-left) */}
      {head.status === 'streaming' && (
        <div className={styles.speechBubble}>
          <SpeechBubbleSvg />
          <AnimatedDots />
        </div>
      )}

      {/* Completed: red unread notification badge */}
      {isCompleted && !head.attentionCleared && (
        <div className={`${styles.notifPip} ${styles.notifPipUnread}`} />
      )}

      {/* Error: pip with X icon */}
      {isError && (
        <div className={styles.notifPip}><X className={styles.notifPipIcon} /></div>
      )}

      <div className={styles.tooltip}>{head.characterName}</div>
    </div>
  )
}

// ── Animated dots ──

function AnimatedDots() {
  return (
    <div className={styles.bubbleDots}>
      <span className={styles.bubbleDot} />
      <span className={styles.bubbleDot} />
      <span className={styles.bubbleDot} />
    </div>
  )
}

// ── Status badge (small online dot) ──

function StatusBadge({ status }: { status: ChatHeadEntry['status'] }) {
  switch (status) {
    case 'assembling':
    case 'council':
      return <div className={`${styles.badge} ${styles.badgeAssembling}`} />
    case 'council_failed':
      return <div className={`${styles.badge} ${styles.badgeError}`} />
    case 'reasoning':
    case 'streaming':
      return <div className={`${styles.badge} ${styles.badgeActive}`} />
    case 'completed':
    case 'stopped':
      return <div className={`${styles.badge} ${styles.badgeCompleted}`} />
    case 'error':
      return <div className={`${styles.badge} ${styles.badgeError}`} />
    default:
      return null
  }
}

// ── SVG bubble shapes ──

/** Thought cloud: rounded cloud body with two trailing circles */
function ThoughtCloudSvg() {
  return (
    <svg className={styles.thoughtCloudSvg} viewBox="0 0 28 22" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M6 2C3.2 2 1 4.2 1 7c0 2.2 1.4 4 3.3 4.7-.1.4-.3.8-.3 1.3 0 1.7 1.3 3 3 3h14c2.8 0 5-2.2 5-5s-2.2-5-5-5c-.3 0-.5 0-.8.1C19.3 3.5 17 2 14 2c-2.2 0-4.2.9-5.5 2.3C7.8 3.5 7 3 6 3V2z"
        fill="rgba(147, 112, 219, 0.88)"
      />
      <circle cx="5" cy="19" r="1.8" fill="rgba(147, 112, 219, 0.65)" />
      <circle cx="2" cy="21" r="1.2" fill="rgba(147, 112, 219, 0.45)" />
    </svg>
  )
}

/** Council bubble: amber speech bubble (red when failed) */
function CouncilBubbleSvg({ failed }: { failed?: boolean }) {
  return (
    <svg className={styles.speechBubbleSvg} viewBox="0 0 28 22" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4 1h20a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-3l-2.5 4.5a.5.5 0 0 1-.9 0L15 16H4a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3z"
        fill={failed ? 'rgba(239, 68, 68, 0.88)' : 'rgba(245, 158, 11, 0.88)'}
      />
    </svg>
  )
}

/** Speech bubble: rounded rectangle with a small tail pointing down-right */
function SpeechBubbleSvg() {
  return (
    <svg className={styles.speechBubbleSvg} viewBox="0 0 28 22" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4 1h20a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-3l-2.5 4.5a.5.5 0 0 1-.9 0L15 16H4a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3z"
        fill="rgba(34, 197, 94, 0.88)"
      />
    </svg>
  )
}
