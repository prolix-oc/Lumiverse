import { useState, useCallback, useMemo, useEffect, useRef, useDeferredValue } from 'react'
import { Marked } from 'marked'
import { healFormattingArtifacts } from '@/lib/formatHealing'
import { createEmphasisAwareRenderer } from '@/lib/markedEmphasisRenderer'
import { createStrictTildeTokenizer } from '@/lib/markedTokenizer'
import { sanitizeRichHtml } from '@/lib/richHtmlSanitizer'
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

type ReasoningRenderMode = 'markdown' | 'text'

// Approximate cutoff where full markdown rendering starts to create enough DOM
// churn during long CoT streams that switching to plain text is noticeably smoother.
const LARGE_REASONING_RENDER_THRESHOLD = 40_000

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: createEmphasisAwareRenderer(),
  tokenizer: createStrictTildeTokenizer(),
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
  const [renderMode, setRenderMode] = useState<ReasoningRenderMode>(() => (
    reasoning.length >= LARGE_REASONING_RENDER_THRESHOLD ? 'text' : 'markdown'
  ))
  const timerRef = useRef<number | null>(null)
  const startTimeRef = useRef<number | null>(null)
  const shouldPreferPlainText = reasoning.length >= LARGE_REASONING_RENDER_THRESHOLD
  const deferredReasoning = useDeferredValue(reasoning)

  const toggle = useCallback(() => {
    setIsOpen((o) => !o)
  }, [])

  const setMarkdownMode = useCallback(() => {
    setRenderMode('markdown')
  }, [])

  const setTextMode = useCallback(() => {
    setRenderMode('text')
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

  useEffect(() => {
    if (shouldPreferPlainText && isStreaming && renderMode === 'markdown') {
      setRenderMode('text')
    }
  }, [shouldPreferPlainText, isStreaming, renderMode])

  const label = reasoningDuration
    ? `Thought for ${formatDuration(reasoningDuration)}`
    : isStreaming && liveElapsed > 0
      ? `Thinking for ${formatDuration(liveElapsed)}`
      : 'Thinking'

  // Skip markdown parsing whenever the block is collapsed — the rendered HTML
  // is not visible, so building it eagerly is pure waste for long reasoning.
  const html = useMemo(
    () => {
      if (!isOpen || renderMode !== 'markdown') return ''
      return sanitizeRichHtml(md.parse(healFormattingArtifacts(deferredReasoning)) as string)
    },
    [deferredReasoning, isOpen, renderMode]
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
          {shouldPreferPlainText && (
            <div className={styles.bodyToolbar}>
              <span className={styles.bodyHint}>Large reasoning blocks open in text mode first.</span>
              <div className={styles.modeSwitch} aria-label="Reasoning render mode">
                <button
                  type="button"
                  className={clsx(styles.modeButton, renderMode === 'text' && styles.modeButtonActive)}
                  onClick={setTextMode}
                  aria-pressed={renderMode === 'text'}
                >
                  Text
                </button>
                <button
                  type="button"
                  className={clsx(styles.modeButton, renderMode === 'markdown' && styles.modeButtonActive)}
                  onClick={setMarkdownMode}
                  aria-pressed={renderMode === 'markdown'}
                >
                  Markdown
                </button>
              </div>
            </div>
          )}
          {renderMode === 'markdown' ? (
            <div
              className={styles.body}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <pre className={clsx(styles.body, styles.bodyPlainText)}>{reasoning}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
