import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Marked } from 'marked'
import { createEmphasisAwareRenderer } from '@/lib/markedEmphasisRenderer'
import { ChevronRight, Brain } from 'lucide-react'
import styles from './ReasoningBlock.module.css'
import clsx from 'clsx'

interface ReasoningBlockProps {
  reasoning: string
  reasoningDuration?: number
  /** Server-side timestamp (epoch ms) when reasoning began — used to resume timer after navigation */
  reasoningStartedAt?: number | null
  isStreaming: boolean
  variant?: 'default' | 'bubble'
  align?: 'left' | 'right'
}

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: createEmphasisAwareRenderer(),
  silent: true,
})

function formatDuration(ms: number) {
  if (!ms || ms < 0) return '0s'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
}

export default function ReasoningBlock({ reasoning, reasoningDuration, reasoningStartedAt, isStreaming, variant = 'default', align }: ReasoningBlockProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [liveElapsed, setLiveElapsed] = useState(0)
  const timerRef = useRef<number | null>(null)
  const startTimeRef = useRef<number | null>(null)

  const toggle = useCallback(() => {
    setIsOpen((o) => !o)
  }, [])

  // Live timer during streaming when no final duration exists yet
  useEffect(() => {
    if (!isStreaming || reasoningDuration) {
      if (timerRef.current) window.clearInterval(timerRef.current)
      timerRef.current = null
      startTimeRef.current = null
      setLiveElapsed(0)
      return
    }

    // Prefer the server-side timestamp (e.g. after navigation recovery) so the
    // timer reflects the true elapsed time, not time-since-remount. If the prop
    // arrives after mount (Zustand updates may not batch), override the fallback.
    if (reasoningStartedAt) {
      startTimeRef.current = reasoningStartedAt
    } else if (!startTimeRef.current) {
      startTimeRef.current = Date.now()
    }

    setLiveElapsed(Date.now() - startTimeRef.current)

    if (!timerRef.current) {
      timerRef.current = window.setInterval(() => {
        if (!startTimeRef.current) return
        setLiveElapsed(Date.now() - startTimeRef.current)
      }, 1000)
    }

    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [isStreaming, reasoningDuration, reasoningStartedAt])

  const label = reasoningDuration
    ? `Thought for ${formatDuration(reasoningDuration)}`
    : isStreaming && liveElapsed > 0
      ? `Thinking for ${formatDuration(liveElapsed)}`
      : 'Thinking'

  // Skip markdown parsing when the block is collapsed during streaming —
  // the rendered HTML isn't visible so parsing is pure waste. Parse once
  // the user expands or when streaming ends (final content).
  const html = useMemo(
    () => (isStreaming && !isOpen) ? '' : md.parse(reasoning) as string,
    [reasoning, isStreaming, isOpen]
  )

  return (
    <div className={clsx(styles.container, variant === 'bubble' && styles.bubble, align === 'right' && styles.alignRight)}>
      <button
        type="button"
        className={styles.toggle}
        onClick={toggle}
        aria-expanded={isOpen}
      >
        <ChevronRight className={clsx(styles.chevron, isOpen && styles.chevronOpen)} />
        <Brain className={styles.brain} />
        <span className={styles.label}>{label}</span>
      </button>
      <div className={clsx(styles.bodyWrapper, isOpen && styles.bodyWrapperOpen)}>
        <div className={styles.bodyInner}>
          <div
            className={styles.body}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </div>
  )
}
