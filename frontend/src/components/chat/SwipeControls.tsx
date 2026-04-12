import { ChevronLeft, ChevronRight } from 'lucide-react'
import useSwipeAction from '@/hooks/useSwipeAction'
import type { Message } from '@/types/api'
import styles from './SwipeControls.module.css'
import clsx from 'clsx'

interface SwipeControlsProps {
  message: Message
  chatId: string
  variant?: 'default' | 'bubble'
}

export default function SwipeControls({ message, chatId, variant = 'default' }: SwipeControlsProps) {
  const { handleSwipe, disableLeft, disableRight } = useSwipeAction(message, chatId)

  const current = message.swipe_id + 1
  const total = message.swipes.length

  return (
    <div data-component="SwipeControls" className={clsx(styles.controls, variant === 'bubble' && styles.bubble)}>
      <button
        type="button"
        className={styles.btn}
        onClick={() => handleSwipe('left')}
        disabled={disableLeft}
        aria-label="Previous swipe"
      >
        <ChevronLeft size={14} />
      </button>
      <span className={styles.counter}>
        {current} / {total}
      </span>
      <button
        type="button"
        className={styles.btn}
        onClick={() => handleSwipe('right')}
        disabled={disableRight}
        aria-label="Next swipe"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}
