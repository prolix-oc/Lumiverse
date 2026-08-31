import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { formatAgentRuntimeProgress } from '@/lib/agentRuntimeProgress'
import type { AgentActivityGeneration } from '@/types/ws-events'
import type { ChatHeadEntry, ChatHeadStatus } from '@/types/store'
import styles from './StreamingIndicator.module.css'

export type StreamingStatus =
  | 'sending'
  | 'queued'
  | 'waiting'
  | 'reasoning'
  | 'streaming'
  | 'continuation'
  | 'completed'
  | 'error'
  | 'stopped'

export interface StreamingStatusInput {
  isStreaming: boolean
  activeGenerationId: string | null
  streamingError: string | null
  terminalStatus?: 'completed' | 'stopped' | 'error' | null
  streamingContent: string
  streamingReasoning: string
  chatHead?: Pick<ChatHeadEntry, 'status' | 'provider' | 'model' | 'connectionLabel' | 'agentOperation' | 'agentLifecycle'> | null
  agentActivity?: AgentActivityGeneration | null
}

function hasActiveToolOrChild(activity: AgentActivityGeneration | null | undefined): boolean {
  if (!activity) return false
  return Object.values(activity.invocations).some((invocation) => {
    const active = invocation.status === 'pending' || invocation.status === 'running'
    return active && (invocation.actor === 'child_profile' || invocation.phase === 'tool_call')
  })
}

function statusFromChatHead(status: ChatHeadStatus | undefined): StreamingStatus | null {
  if (status === 'assembling') return 'queued'
  if (status === 'waiting') return 'waiting'
  if (status === 'reasoning') return 'reasoning'
  if (status === 'streaming') return 'streaming'
  if (status === 'completed') return 'completed'
  if (status === 'stopped') return 'stopped'
  if (status === 'error' || status === 'council_failed') return 'error'
  if (status === 'council') return 'continuation'
  return null
}
export function deriveStreamingStatus(input: StreamingStatusInput): StreamingStatus {
  if (input.streamingError || input.terminalStatus === 'error') return 'error'
  if (input.terminalStatus === 'stopped') return 'stopped'
  if (!input.isStreaming) return 'completed'
  if (!input.activeGenerationId) return 'sending'
  if (hasActiveToolOrChild(input.agentActivity)) return 'continuation'

  const headStatus = statusFromChatHead(input.chatHead?.status)
  if (headStatus) {
    if (headStatus === 'streaming' && !input.streamingContent && !input.streamingReasoning) {
      return 'waiting'
    }
    return headStatus
  }
  if (input.streamingContent || input.streamingReasoning) return 'streaming'
  return 'queued'
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const minutes = Math.floor(seconds / 60)
  return String(minutes).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0')
}

function activityForGeneration(
  activities: Record<string, AgentActivityGeneration>,
  generationId: string | null,
): AgentActivityGeneration | null {
  if (!generationId) return null
  for (const [key, activity] of Object.entries(activities)) {
    if (activity.generationId === generationId || key.startsWith(generationId + '\u0000')) return activity
  }
  return null
}

export default function StreamingIndicator() {
  const { t } = useTranslation('chat')
  const isStreaming = useStore((state) => state.isStreaming)
  const activeGenerationId = useStore((state) => state.activeGenerationId)
  const streamingError = useStore((state) => state.streamingError)
  const terminalStatus = useStore((state) => state.lastGenerationTerminalStatus)
  const streamingContent = useStore((state) => state.streamingContent)
  const streamingReasoning = useStore((state) => state.streamingReasoning)
  const streamingGenerationType = useStore((state) => state.streamingGenerationType)
  const activeChatId = useStore((state) => state.activeChatId)
  const chatHeads = useStore((state) => state.chatHeads)
  const lastGenerationProvider = useStore((state) => state.lastGenerationProvider)
  const lastGenerationModel = useStore((state) => state.lastGenerationModel)
  const lastGenerationConnectionLabel = useStore((state) => state.lastGenerationConnectionLabel)
  const agentActivityByGeneration = useStore((state) => state.agentActivityByGeneration)
  const chatHead = chatHeads.find(
    (candidate) => candidate.chatId === activeChatId && candidate.generationId === activeGenerationId,
  )
  const agentActivity = activityForGeneration(agentActivityByGeneration, activeGenerationId)
  const snapshot = {
    isStreaming,
    activeGenerationId,
    streamingError,
    terminalStatus,
    streamingContent,
    streamingReasoning,
    streamingGenerationType,
    chatHead,
    agentActivity,
  }
  const [now, setNow] = useState(() => Date.now())
  const status = deriveStreamingStatus(snapshot)
  const live = status !== 'completed' && status !== 'error' && status !== 'stopped'
  const startedAt = snapshot.chatHead?.startedAt ?? null

  useEffect(() => {
    if (!live || startedAt == null) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [live, startedAt])

  const elapsed = startedAt == null ? null : Math.max(0, now - startedAt)
  const waitingTooLong = live && elapsed != null && elapsed >= 30_000 && (
    status === 'queued' || status === 'waiting' || status === 'reasoning' || status === 'continuation'
  )
  const outputCount = snapshot.streamingContent.length + snapshot.streamingReasoning.length
  const activityCount = snapshot.agentActivity
    ? Object.values(snapshot.agentActivity.invocations).filter((invocation) => invocation.status === 'pending' || invocation.status === 'running').length
    : 0
  const provider = snapshot.chatHead?.provider || lastGenerationProvider || t('generationStatus.notReported')
  const model = snapshot.chatHead?.model || lastGenerationModel || t('generationStatus.notReported')
  const connectionLabel = snapshot.chatHead?.connectionLabel || lastGenerationConnectionLabel
  const operationProgress = formatAgentRuntimeProgress(
    snapshot.chatHead?.agentOperation,
    snapshot.chatHead?.agentLifecycle,
    t,
  )
  const statusLabel = t('generationStatus.' + status)
  const progress = operationProgress
    ? operationProgress
    : status === 'continuation'
      ? t('generationStatus.activeOperations', { count: activityCount })
      : status === 'streaming'
        ? t('generationStatus.output', { count: outputCount })
        : status === 'reasoning'
          ? t('generationStatus.reasoningOutput', { count: snapshot.streamingReasoning.length })
          : null

  return (
    <div
      className={styles.indicator}
      role="status"
      aria-live="polite"
      data-generation-id={snapshot.activeGenerationId ?? undefined}
      data-generation-status={status}
      data-generation-type={snapshot.streamingGenerationType ?? undefined}
    >
      <span className={styles.dots} aria-hidden="true">
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
      </span>
      <span className={styles.statusText}>
        <strong>{statusLabel}</strong>
        <span className={styles.details}>
          {t('generationStatus.providerModel', { provider, model })}
          {connectionLabel ? ' · ' + connectionLabel : ''}
          {elapsed != null ? ' · ' + t('generationStatus.elapsed', { duration: formatElapsed(elapsed) }) : ''}
          {progress ? ' · ' + progress : ''}
        </span>
        {waitingTooLong ? <span className={styles.recovery}>{t('generationStatus.recovery')}</span> : null}
        {snapshot.streamingError ? <span className={styles.recovery}>{snapshot.streamingError}</span> : null}
        {status === 'stopped' ? <span className={styles.recovery}>{t('generationStatus.stoppedRecovery')}</span> : null}
      </span>
    </div>
  )
}
