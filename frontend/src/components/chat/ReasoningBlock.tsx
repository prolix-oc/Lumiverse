import { useState, useCallback, useMemo, useEffect, useRef, useDeferredValue } from 'react'
import { useTranslation } from 'react-i18next'
import { Marked } from 'marked'
import { healFormattingArtifacts } from '@/lib/formatHealing'
import { createEmphasisAwareRenderer } from '@/lib/markedEmphasisRenderer'
import { createStrictTildeTokenizer } from '@/lib/markedTokenizer'
import { sanitizeRichHtml } from '@/lib/richHtmlSanitizer'
import { Ban, Brain, CheckCircle2, ChevronRight, CircleX, Clock3, LoaderCircle, Wrench } from 'lucide-react'
import { dispatchCollapsibleToggleLayoutEvent } from './collapsibleLayout'
import styles from './ReasoningBlock.module.css'
import clsx from 'clsx'
import type { AgentSummary } from '@/types/api'
import type { AgentActivityGeneration, AgentActivityInvocation } from '@/types/ws-events'

export interface ReasoningBlockProps {
  reasoning: string
  reasoningDuration?: number
  /** Server-side timestamp (epoch ms) when reasoning began — used to resume timer after navigation */
  reasoningStartedAt?: number | null
  isStreaming: boolean
  agentActivity?: AgentActivityGeneration
  agentSummary?: AgentSummary
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

function AgentStatusIcon({ status }: { status: AgentActivityInvocation['status'] }) {
  if (status === 'succeeded') return <CheckCircle2 aria-hidden="true" />
  if (status === 'failed') return <CircleX aria-hidden="true" />
  if (status === 'cancelled') return <Ban aria-hidden="true" />
  if (status === 'timed_out') return <Clock3 aria-hidden="true" />
  return <LoaderCircle className={styles.activitySpinner} aria-hidden="true" />
}

function AgentActivityRow({
  invocationId,
  activity,
  childIdsByParent,
  now,
  ancestors,
}: {
  invocationId: string
  activity: AgentActivityGeneration
  childIdsByParent: Record<string, string[]>
  now: number
  ancestors: readonly string[]
}) {
  const { t } = useTranslation('chat')
  const invocation = activity.invocations[invocationId]
  if (!invocation || ancestors.includes(invocationId)) return null

  const isRunning = invocation.status === 'pending' || invocation.status === 'running'
  const elapsedMs = isRunning
    ? Math.max(invocation.elapsedMs, now - invocation.startedAt)
    : invocation.elapsedMs
  const status = t(`agentActivity.status.${invocation.status}`)
  const phase = t(`agentActivity.phase.${invocation.phase}`)
  const children = childIdsByParent[invocationId] ?? []
  const nextAncestors = [...ancestors, invocationId]
  const actorLabel = invocation.actor === 'main_model'
    ? t('agentActivity.actors.mainModel')
    : invocation.profileName ?? ''

  return (
    <li className={styles.activityItem}>
      <div
        className={styles.activityRow}
        data-status={invocation.status}
        aria-label={t('agentActivity.rowAria', { profile: actorLabel, status })}
      >
        <span className={styles.activityStatusIcon}>
          <AgentStatusIcon status={invocation.status} />
        </span>
        <span className={styles.activityProfile}>{actorLabel}</span>
        <span className={styles.activityDetail}>
          {invocation.toolName ? (
            <>
              <Wrench aria-hidden="true" />
              {t(`agentActivity.tools.${invocation.toolName}`)}
            </>
          ) : phase}
        </span>
        <span className={styles.activityStatus}>{status}</span>
        <span className={styles.activityElapsed}>{formatDuration(elapsedMs)}</span>
      </div>
      {children.length > 0 && (
        <ul className={styles.activityChildren}>
          {children.map((childId) => (
            <AgentActivityRow
              key={childId}
              invocationId={childId}
              activity={activity}
              childIdsByParent={childIdsByParent}
              now={now}
              ancestors={nextAncestors}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export function AgentActivityDetails({
  activity,
  now,
}: {
  activity: AgentActivityGeneration
  now: number
}) {
  const { t } = useTranslation('chat')
  const { childIdsByParent, rootIds } = useMemo(() => {
    const children: Record<string, string[]> = {}
    const roots: string[] = []

    for (const invocationId of activity.invocationOrder) {
      const invocation = activity.invocations[invocationId]
      if (!invocation) continue
      const parentId = invocation.parentInvocationId
      if (parentId && parentId !== invocationId && activity.invocations[parentId]) {
        ;(children[parentId] ??= []).push(invocationId)
      } else {
        roots.push(invocationId)
      }
    }

    if (roots.length === 0 && activity.invocationOrder.length > 0) {
      roots.push(activity.invocationOrder[0])
    }
    return { childIdsByParent: children, rootIds: roots }
  }, [activity])

  const aggregateUsage = useMemo(() => {
    let inputTokens = 0
    let outputTokens = 0
    let totalTokens = 0
    let hasUsage = false
    for (const invocationId of activity.invocationOrder) {
      const usage = activity.invocations[invocationId]?.usage
      if (!usage) continue
      hasUsage = true
      inputTokens += usage.inputTokens
      outputTokens += usage.outputTokens
      totalTokens += usage.totalTokens
    }
    return { inputTokens, outputTokens, totalTokens, hasUsage }
  }, [activity])

  return (
    <div className={styles.activityPanel}>
      <ul className={styles.activityList} aria-label={t('agentActivity.liveAria')}>
        {rootIds.map((invocationId) => (
          <AgentActivityRow
            key={invocationId}
            invocationId={invocationId}
            activity={activity}
            childIdsByParent={childIdsByParent}
            now={now}
            ancestors={[]}
          />
        ))}
      </ul>
      {aggregateUsage.hasUsage && (
        <div className={styles.activityUsage}>
          {t('agentActivity.usage', {
            total: aggregateUsage.totalTokens.toLocaleString(),
            input: aggregateUsage.inputTokens.toLocaleString(),
            output: aggregateUsage.outputTokens.toLocaleString(),
          })}
        </div>
      )}
    </div>
  )
}

export function visibleActivityRunCount(summary: AgentSummary): number {
  if (summary.invocationCount > 0) return summary.invocationCount
  if (summary.succeededCount > 0) return summary.succeededCount
  return summary.status === 'succeeded' ? 1 : 0
}

export function AgentSummaryDetails({ summary }: { summary: AgentSummary }) {
  const { t } = useTranslation('chat')
  const status = t(`agentActivity.status.${summary.status}`)
  const invocationCount = visibleActivityRunCount(summary)
  const succeededCount = summary.succeededCount > 0
    ? summary.succeededCount
    : summary.status === 'succeeded' ? 1 : 0
  const counts = [
    t('agentActivity.summary.invocations', { count: invocationCount }),
    succeededCount > 0
      ? t('agentActivity.summary.succeeded', { count: succeededCount })
      : null,
    summary.failedCount > 0
      ? t('agentActivity.summary.failed', { count: summary.failedCount })
      : null,
    summary.cancelledCount > 0
      ? t('agentActivity.summary.cancelled', { count: summary.cancelledCount })
      : null,
    summary.timedOutCount > 0
      ? t('agentActivity.summary.timedOut', { count: summary.timedOutCount })
      : null,
    summary.toolCallCount > 0
      ? t('agentActivity.summary.tools', { count: summary.toolCallCount })
      : null,
  ].filter((count): count is string => count !== null)

  return (
    <div className={styles.summaryPanel}>
      <div className={styles.summaryStatus} data-status={summary.status}>
        <AgentStatusIcon status={summary.status} />
        <span>{status}</span>
      </div>
      <div className={styles.summaryCounts}>
        {counts.map((count) => <span key={count}>{count}</span>)}
      </div>
    </div>
  )
}

export default function ReasoningBlock({
  reasoning,
  reasoningDuration,
  reasoningStartedAt,
  isStreaming,
  agentActivity,
  agentSummary,
  variant = 'default',
  align,
}: ReasoningBlockProps) {
  const { t } = useTranslation('chat')
  const [isOpen, setIsOpen] = useState(false)
  const [liveElapsed, setLiveElapsed] = useState(0)
  const [renderMode, setRenderMode] = useState<ReasoningRenderMode>(() => (
    reasoning.length >= LARGE_REASONING_RENDER_THRESHOLD ? 'text' : 'markdown'
  ))
  const containerRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)
  const startTimeRef = useRef<number | null>(null)
  const shouldPreferPlainText = reasoning.length >= LARGE_REASONING_RENDER_THRESHOLD
  const wasLargeReasoningRef = useRef(shouldPreferPlainText)
  const deferredReasoning = useDeferredValue(reasoning)
  const liveInvocationIds = agentActivity?.invocationOrder.filter(
    (invocationId) => !!agentActivity.invocations[invocationId],
  ) ?? []
  const activeInvocationCount = liveInvocationIds.reduce((count, invocationId) => {
    const status = agentActivity?.invocations[invocationId]?.status
    return status === 'pending' || status === 'running' ? count + 1 : count
  }, 0)
  const hasLiveActivity = liveInvocationIds.length > 0
  const hasActiveActivity = activeInvocationCount > 0
  const activityStartedAt = useMemo(() => {
    if (!agentActivity || !hasActiveActivity) return null
    let earliest: number | null = null
    for (const invocationId of agentActivity.invocationOrder) {
      const invocation = agentActivity.invocations[invocationId]
      if (!invocation || (invocation.status !== 'pending' && invocation.status !== 'running')) continue
      earliest = earliest === null ? invocation.startedAt : Math.min(earliest, invocation.startedAt)
    }
    return earliest
  }, [agentActivity, hasActiveActivity])

  const toggle = useCallback(() => {
    dispatchCollapsibleToggleLayoutEvent(containerRef.current)
    setIsOpen((open) => !open)
  }, [])

  const setMarkdownMode = useCallback(() => {
    setRenderMode('markdown')
  }, [])

  const setTextMode = useCallback(() => {
    setRenderMode('text')
  }, [])

  // Keep the existing reasoning timer and also refresh active child elapsed time.
  useEffect(() => {
    if (!isStreaming || (reasoningDuration && !hasActiveActivity)) {
      if (timerRef.current) window.clearInterval(timerRef.current)
      timerRef.current = null
      startTimeRef.current = null
      setLiveElapsed(0)
      return
    }

    const serverStartedAt = reasoningStartedAt || activityStartedAt
    if (serverStartedAt) {
      startTimeRef.current = serverStartedAt
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
  }, [isStreaming, reasoningDuration, reasoningStartedAt, activityStartedAt, hasActiveActivity])

  useEffect(() => {
    const crossedLargeThreshold = shouldPreferPlainText && !wasLargeReasoningRef.current
    wasLargeReasoningRef.current = shouldPreferPlainText

    if (crossedLargeThreshold && isStreaming && renderMode === 'markdown') {
      setRenderMode('text')
    }
  }, [shouldPreferPlainText, isStreaming, renderMode])

  const reasoningLabel = reasoningDuration
    ? t('reasoning.thoughtFor', { duration: formatDuration(reasoningDuration) })
    : isStreaming && liveElapsed > 0
      ? t('reasoning.thinkingFor', { duration: formatDuration(liveElapsed) })
      : t('reasoning.thinking')
  const label = hasLiveActivity
    ? activeInvocationCount > 0
      ? t('agentActivity.liveLabel', { count: activeInvocationCount })
      : t('agentActivity.idleLabel')
    : agentSummary && !reasoning
      ? t('agentActivity.summaryLabel', {
          count: visibleActivityRunCount(agentSummary),
          status: t(`agentActivity.status.${agentSummary.status}`),
        })
      : reasoningLabel

  // Skip markdown parsing whenever the block is collapsed — the rendered HTML
  // is not visible, so building it eagerly is pure waste for long reasoning.
  const html = useMemo(
    () => {
      if (!reasoning || !isOpen || renderMode !== 'markdown') return ''
      return sanitizeRichHtml(md.parse(healFormattingArtifacts(deferredReasoning)) as string)
    },
    [deferredReasoning, isOpen, reasoning, renderMode],
  )
  const activityNow = startTimeRef.current
    ? startTimeRef.current + liveElapsed
    : 0

  return (
    <div
      ref={containerRef}
      className={clsx(styles.container, variant === 'bubble' && styles.bubble, align === 'right' && styles.alignRight)}
    >
      <button
        type="button"
        className={styles.toggle}
        onClick={toggle}
        aria-expanded={isOpen}
        data-reasoning-toggle="true"
      >
        <ChevronRight className={clsx(styles.chevron, isOpen && styles.chevronOpen)} />
        <Brain className={styles.brain} />
        <span className={styles.label}>{label}</span>
      </button>
      <div className={clsx(styles.bodyWrapper, isOpen && styles.bodyWrapperOpen)}>
        <div className={styles.bodyInner}>
          {hasLiveActivity && agentActivity && (
            <AgentActivityDetails activity={agentActivity} now={activityNow} />
          )}
          {!hasLiveActivity && agentSummary && (
            <AgentSummaryDetails summary={agentSummary} />
          )}
          {reasoning && shouldPreferPlainText && (
            <div className={styles.bodyToolbar}>
              <span className={styles.bodyHint}>{t('reasoning.largeBlockHint')}</span>
              <div className={styles.modeSwitch} aria-label={t('reasoning.renderModeAria')}>
                <button
                  type="button"
                  className={clsx(styles.modeButton, renderMode === 'text' && styles.modeButtonActive)}
                  onClick={setTextMode}
                  aria-pressed={renderMode === 'text'}
                >
                  {t('reasoning.text')}
                </button>
                <button
                  type="button"
                  className={clsx(styles.modeButton, renderMode === 'markdown' && styles.modeButtonActive)}
                  onClick={setMarkdownMode}
                  aria-pressed={renderMode === 'markdown'}
                >
                  {t('reasoning.markdown')}
                </button>
              </div>
            </div>
          )}
          {reasoning && (renderMode === 'markdown' ? (
            <div
              className={styles.body}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <pre className={clsx(styles.body, styles.bodyPlainText)}>{reasoning}</pre>
          ))}
        </div>
      </div>
    </div>
  )
}
