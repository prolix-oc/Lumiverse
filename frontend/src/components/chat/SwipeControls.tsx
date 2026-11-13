import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import useSwipeAction, { executeSwipe } from '@/hooks/useSwipeAction'
import { useStore } from '@/store'
import type { Message } from '@/types/api'
import styles from './SwipeControls.module.css'
import clsx from 'clsx'

interface SwipeControlsProps {
  message: Message
  chatId: string
  variant?: 'default' | 'bubble'
}

type DotMode = 'live' | 'ready' | null

export default function SwipeControls({ message, chatId, variant = 'default' }: SwipeControlsProps) {
  const { t } = useTranslation('chat')
  const { handleSwipe, disableLeft, disableRight, isStreamTarget, liveSwipeId } = useSwipeAction(message, chatId)

  // A freshly-generated swipe the user hasn't navigated to yet (they stayed on
  // an older swipe while it generated). Cleared once they land on it.
  const unseenSwipeId = useStore((s) => s.unseenSwipes[message.id])
  const clearUnseenSwipe = useStore((s) => s.clearUnseenSwipe)

  useEffect(() => {
    if (unseenSwipeId != null && message.swipe_id === unseenSwipeId) {
      clearUnseenSwipe(message.id)
    }
  }, [unseenSwipeId, message.swipe_id, message.id, clearUnseenSwipe])

  const hold = useRef<{ timer?: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean }>({ x: 0, y: 0, fired: false })
  const cancelHold = () => {
    clearTimeout(hold.current.timer)
    hold.current.timer = undefined
  }
  useEffect(() => () => { clearTimeout(hold.current.timer) }, [chatId, message.id])

  const current = message.swipe_id + 1
  const total = message.swipes.length

  // During streaming: a pulsing dot toward the swipe being generated.
  // After completion: a steady dot toward the freshly-generated, still-unseen
  // swipe. Streaming takes precedence (its dot is suppressed by !isStreamTarget).
  const liveToRight = isStreamTarget && liveSwipeId != null && message.swipe_id < liveSwipeId
  const liveToLeft = isStreamTarget && liveSwipeId != null && message.swipe_id > liveSwipeId
  const readyToRight = !isStreamTarget && unseenSwipeId != null && message.swipe_id < unseenSwipeId
  const readyToLeft = !isStreamTarget && unseenSwipeId != null && message.swipe_id > unseenSwipeId

  const rightDot: DotMode = liveToRight ? 'live' : readyToRight ? 'ready' : null
  const leftDot: DotMode = liveToLeft ? 'live' : readyToLeft ? 'ready' : null

  const dotClass = (mode: 'live' | 'ready') =>
    clsx(styles.dot, mode === 'live' ? styles.dotLive : styles.dotReady)
  const dotLabel = (mode: DotMode, fallback: string) =>
    mode === 'live' ? t('swipe.live') : mode === 'ready' ? t('swipe.ready') : fallback

  return (
    <div data-component="SwipeControls" className={clsx(styles.controls, variant === 'bubble' && styles.bubble)}>
      <button
        type="button"
        className={clsx(styles.btn, leftDot && styles.btnAccent)}
        onClick={() => handleSwipe('left')}
        disabled={disableLeft}
        aria-label={dotLabel(leftDot, t('swipe.previous'))}
      >
        <ChevronLeft size={14} aria-hidden="true" />
        {leftDot && <span className={dotClass(leftDot)} aria-hidden="true" />}
      </button>
      <span className={styles.counter}>
        {current} / {total}
      </span>
      <button
        type="button"
        className={clsx(styles.btn, styles.next, rightDot && styles.btnAccent)}
        onPointerDown={(event) => {
          cancelHold()
          hold.current.fired = false
          if (event.pointerType !== 'touch' || !event.isPrimary) return
          hold.current.x = event.clientX
          hold.current.y = event.clientY
          hold.current.timer = setTimeout(() => {
            hold.current.timer = undefined
            hold.current.fired = true
            void executeSwipe(message, chatId, 'right', { background: true })
          }, 450)
        }}
        onPointerMove={(event) => {
          if (Math.hypot(event.clientX - hold.current.x, event.clientY - hold.current.y) > 10) cancelHold()
        }}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onPointerLeave={cancelHold}
        onTouchStart={(event) => event.stopPropagation()}
        onContextMenuCapture={(event) => { event.preventDefault(); event.stopPropagation() }}
        onClick={(event) => {
          if (hold.current.fired) {
            hold.current.fired = false
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (event.ctrlKey || event.metaKey) void executeSwipe(message, chatId, 'right', { background: true })
          else void handleSwipe('right')
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            event.stopPropagation()
            void executeSwipe(message, chatId, 'right', { background: true })
          }
        }}
        title={t('swipe.backgroundHint', { defaultValue: 'Hold on touch, Ctrl/Cmd-click or Ctrl/Cmd-Enter: generate a swipe in the background' })}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        disabled={disableRight}
        aria-label={dotLabel(rightDot, t('swipe.next'))}
      >
        <ChevronRight size={14} aria-hidden="true" />
        {rightDot && <span className={dotClass(rightDot)} aria-hidden="true" />}
      </button>
    </div>
  )
}
