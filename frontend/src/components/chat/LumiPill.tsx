import { useState, useEffect, useRef, useCallback } from 'react'
import { wsClient } from '@/ws/client'
import { EventType } from '@/types/ws-events'
import clsx from 'clsx'
import styles from './LumiPill.module.css'

type PillState = 'hidden' | 'loading' | 'complete'

export default function LumiPill() {
  const [state, setState] = useState<PillState>('hidden')
  const [moduleCount, setModuleCount] = useState(0)
  const [doneCount, setDoneCount] = useState(0)
  const [totalTokens, setTotalTokens] = useState(0)
  const [fadingOut, setFadingOut] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current)
      fadeTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    const unsubs = [
      wsClient.on(EventType.LUMI_PIPELINE_STARTED, (payload: { moduleCount?: number }) => {
        clearTimers()
        setFadingOut(false)
        setDoneCount(0)
        setTotalTokens(0)
        setModuleCount(payload.moduleCount || 0)
        setState('loading')
      }),

      wsClient.on(EventType.LUMI_MODULE_DONE, (payload: { usage?: { total_tokens: number } }) => {
        setDoneCount((prev) => prev + 1)
        if (payload.usage?.total_tokens) {
          setTotalTokens((prev) => prev + payload.usage!.total_tokens)
        }
      }),

      wsClient.on(EventType.LUMI_PIPELINE_COMPLETED, (payload: { totalUsage?: { total_tokens: number } }) => {
        // Use the authoritative totalUsage if available
        if (payload.totalUsage?.total_tokens) {
          setTotalTokens(payload.totalUsage.total_tokens)
        }
        setState('complete')

        // Start fade-out after 2s
        hideTimerRef.current = setTimeout(() => {
          setFadingOut(true)
          // After fade animation completes (400ms), hide entirely
          fadeTimerRef.current = setTimeout(() => {
            setState('hidden')
            setFadingOut(false)
            setDoneCount(0)
            setModuleCount(0)
            setTotalTokens(0)
          }, 400)
        }, 2000)
      }),
    ]

    return () => {
      unsubs.forEach((unsub) => unsub())
      clearTimers()
    }
  }, [clearTimers])

  if (state === 'hidden') return null

  return (
    <div
      className={clsx(styles.wrapper, fadingOut && styles.fadingOut)}
      data-state={state}
    >
      <div
        className={clsx(
          styles.indicator,
          state === 'loading' && styles.loading,
          state === 'complete' && styles.complete,
        )}
      >
        <span className={styles.zapIcon}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </span>
        <span className={styles.label}>
          {state === 'loading'
            ? `Lumi ${doneCount}/${moduleCount}`
            : totalTokens > 0
              ? `Lumi (${totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens} tok)`
              : 'Lumi'}
        </span>
        {state === 'complete' && (
          <span className={styles.completeIcon}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </span>
        )}
      </div>
    </div>
  )
}
