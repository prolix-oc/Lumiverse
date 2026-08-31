import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { wsClient } from '@/ws/client'
import { EventType } from '@/types/ws-events'
import type { AgentCouncilReceiptV1 } from '@/types/agent-runs'
import clsx from 'clsx'
import styles from './CouncilPill.module.css'

const FALLBACK_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%239370DB'/%3E%3Ctext x='12' y='16' text-anchor='middle' fill='white' font-size='10'%3E?%3C/text%3E%3C/svg%3E"

interface RespondedMember {
  memberName: string
  avatarUrl: string | null
}

type PillState = 'hidden' | 'loading' | 'complete'

export default function CouncilPill() {
  const { t } = useTranslation('chat')
  const [state, setState] = useState<PillState>('hidden')
  const [members, setMembers] = useState<RespondedMember[]>([])
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
      wsClient.on(EventType.COUNCIL_STARTED, () => {
        clearTimers()
        setFadingOut(false)
        setMembers([])
        setState('loading')
      }),

      wsClient.on(EventType.COUNCIL_MEMBER_DONE, (payload: {
        memberName?: string
        memberAvatarUrl?: string | null
        results?: unknown[]
      }) => {
        const name = payload.memberName || t('council.memberFallback')
        const avatarUrl = payload.memberAvatarUrl || null
        setMembers((prev) => [...prev, { memberName: name, avatarUrl }])
      }),

      wsClient.on(EventType.COUNCIL_COMPLETED, () => {
        setState('complete')

        hideTimerRef.current = setTimeout(() => {
          setFadingOut(true)
          fadeTimerRef.current = setTimeout(() => {
            setState('hidden')
            setFadingOut(false)
            setMembers([])
          }, 400)
        }, 2000)
      }),
    ]

    return () => {
      unsubs.forEach((unsub) => unsub())
      clearTimers()
    }
  }, [clearTimers, t])

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
        <span className={styles.label}>{t('council.label')}</span>
        <div className={styles.avatarStack}>
          {members.map((m, i) => (
            <img
              key={i}
              className={styles.avatar}
              src={m.avatarUrl || FALLBACK_SVG}
              alt={m.memberName}
              title={t('council.hasSpoken', { name: m.memberName })}
            />
          ))}
          {members.length > 6 && (
            <span className={styles.overflow}>+{members.length - 6}</span>
          )}
        </div>
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

/** Distinct WORK receipt presentation; the Response CouncilPill above remains event-driven. */
export function WorkCouncilPill({ receipt }: {
  receipt: Pick<AgentCouncilReceiptV1, 'state' | 'required' | 'memberCount'>
}) {
  const { t } = useTranslation('chat')
  const stateLabel = t(`agentRun.receipts.states.${receipt.state}`)
  const requirementLabel = receipt.required
    ? t('council.workReceipt.required')
    : t('council.workReceipt.optional')

  return (
    <div className={styles.wrapper} data-kind="work-council" data-state={receipt.state} role="status">
      <div className={styles.indicator} data-kind="work-council">
        <span className={styles.label}>{t('council.workReceipt.label')}</span>
        <span className={styles.label}>{stateLabel}</span>
        <span className={styles.label}>
          {t('council.workReceipt.members', { count: receipt.memberCount })}
        </span>
        <span className={styles.label}>{requirementLabel}</span>
      </div>
    </div>
  )
}
