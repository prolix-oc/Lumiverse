import type { CortexIngestionStatus } from '@/api/memory-cortex'

export const CORTEX_ERROR_NOTICE_VISIBLE_MS = 8_000

export interface CortexNotice {
  variant: 'processing' | 'error'
  title: string
  detail: string
  percent?: number
  errorKey?: string
  occurredAt?: number
}

export interface CortexRebuildStatus {
  chatId?: string
  status: string
  current?: number
  total?: number
  percent?: number
  error?: string
  source?: string
  startedAt?: number
  updatedAt?: number
}

type Translator = (key: string, opts?: Record<string, unknown>) => string

function formatChunkProgress(payload: CortexRebuildStatus, t: Translator): string {
  const current = payload.current ?? 0
  const total = payload.total ?? 0
  return total > 0 ? t('chatView.cortexChunks', { current, total }) : ''
}

function formatCortexError(error: string | undefined, t: Translator, fallbackKey: string): string {
  // Sidecar status codes are internal implementation details. They arrive via
  // the progress socket rather than a user-facing error contract, so never
  // render values such as "sidecar_failed" in the memory notice.
  if (/^sidecar(?:[_\s-].*)?$/i.test(error?.trim() ?? '')) {
    return t(fallbackKey)
  }
  return error || t(fallbackKey)
}

function formatIngestionDetail(status: CortexIngestionStatus, t: Translator): string {
  const phaseDetail: Record<CortexIngestionStatus['phase'], string> = {
    queued: t('chatView.cortexQueued'),
    font: t('chatView.cortexFont'),
    heuristics: t('chatView.cortexHeuristics'),
    sidecar: t('chatView.cortexSidecar'),
    persisting: t('chatView.cortexPersisting'),
    complete: t('chatView.cortexComplete'),
    error: formatCortexError(status.error, t, 'chatView.cortexProcessingFailed'),
  }

  return phaseDetail[status.phase] + (status.pendingJobs > 1 ? t('chatView.cortexJobsPending', { count: status.pendingJobs }) : '')
}

function formatRebuildDetail(payload: CortexRebuildStatus, t: Translator): string {
  // Rebuild progress is emitted only by the Cortex-derived-state pipeline.
  // The same /warm request may also queue LTCM embeddings, but those are not
  // sidecar analysis and deliberately do not drive this notice.
  const action = payload.source === 'warmup'
    ? t('chatView.cortexPreparingMemory')
    : t('chatView.cortexRebuildingMemory')

  return action + formatChunkProgress(payload, t)
}

function errorKey(kind: 'ingestion' | 'rebuild', status: CortexIngestionStatus | CortexRebuildStatus): string {
  const occurrence = status.updatedAt ?? ('startedAt' in status ? status.startedAt : undefined) ?? 'unknown'
  return `${kind}:${status.chatId ?? 'unknown'}:${occurrence}:${status.error ?? 'unknown'}`
}

export function buildCortexNotice(
  ingestionStatus: CortexIngestionStatus | null,
  rebuildStatus: CortexRebuildStatus | null,
  t: Translator,
): CortexNotice | null {
  if (rebuildStatus?.status === 'error') {
    return {
      variant: 'error',
      title: t('chatView.memory'),
      detail: formatCortexError(rebuildStatus.error, t, 'chatView.memoryRebuildFailed'),
      percent: rebuildStatus.percent,
      errorKey: errorKey('rebuild', rebuildStatus),
      occurredAt: rebuildStatus.updatedAt ?? rebuildStatus.startedAt,
    }
  }

  if (ingestionStatus?.status === 'error') {
    return {
      variant: 'error',
      title: t('chatView.memory'),
      detail: formatCortexError(ingestionStatus.error, t, 'chatView.backgroundMemoryFailed'),
      errorKey: errorKey('ingestion', ingestionStatus),
      occurredAt: ingestionStatus.updatedAt,
    }
  }

  const rebuildProcessing = rebuildStatus?.status === 'processing'
  const ingestionProcessing = ingestionStatus?.status === 'processing'

  if (rebuildProcessing && ingestionProcessing) {
    return {
      variant: 'processing',
      title: t('chatView.memory'),
      detail: t('chatView.cortexCombined', { chunks: formatChunkProgress(rebuildStatus, t) }),
      percent: rebuildStatus.percent,
    }
  }

  if (rebuildProcessing) {
    return {
      variant: 'processing',
      title: t('chatView.memory'),
      detail: formatRebuildDetail(rebuildStatus, t),
      percent: rebuildStatus.percent,
    }
  }

  if (ingestionProcessing) {
    return {
      variant: 'processing',
      title: t('chatView.memory'),
      detail: formatIngestionDetail(ingestionStatus, t),
    }
  }

  return null
}

export function cortexErrorNoticeRemainingMs(notice: CortexNotice, now = Date.now()): number {
  if (notice.variant !== 'error') return 0
  if (typeof notice.occurredAt !== 'number') return CORTEX_ERROR_NOTICE_VISIBLE_MS
  return Math.max(0, CORTEX_ERROR_NOTICE_VISIBLE_MS - Math.max(0, now - notice.occurredAt))
}

export function hideDismissedCortexError(
  notice: CortexNotice | null,
  dismissedErrorKey: string | null,
  now = Date.now(),
): CortexNotice | null {
  if (notice?.variant !== 'error') return notice
  if (cortexErrorNoticeRemainingMs(notice, now) === 0) return null
  return notice.errorKey === dismissedErrorKey ? null : notice
}

export function normalizeRebuildStatus(payload: CortexRebuildStatus | null): CortexRebuildStatus | null {
  if (!payload) return null
  return payload.status === 'idle' || payload.status === 'complete' ? null : payload
}
