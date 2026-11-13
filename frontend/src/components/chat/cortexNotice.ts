import type { CortexIngestionStatus, CortexActivitySnapshot, CortexActivityRun } from '@/api/memory-cortex'

export const CORTEX_ERROR_NOTICE_VISIBLE_MS = 8_000

export interface CortexNotice {
  variant: 'processing' | 'error'
  title: string
  detail: string
  percent?: number
  errorKey?: string
  occurredAt?: number
  elapsed?: string
  batches?: Array<{ id: string; label: string; detail: string; phase: string }>
}

export interface CortexRebuildStatus {
  chatId?: string
  status: string
  current?: number
  total?: number
  percent?: number
  phase?: string
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
  if (payload.phase === 'consolidating') return t('chatView.cortexConsolidatingScenes')
  if (payload.phase === 'consolidating_arcs') return t('chatView.cortexConsolidatingArcs')

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
  activity?: CortexActivitySnapshot | null,
  requestedAt?: number | null,
  now = Date.now(),
  initiatedAt?: number | null,
): CortexNotice | null {
  const runs = activity?.runs.filter((run) => run.status === 'processing') ?? []
  if (runs.length || requestedAt) return buildActivityNotice(runs, requestedAt ?? initiatedAt, t, now)
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

  if (rebuildProcessing && (rebuildStatus.phase === 'consolidating' || rebuildStatus.phase === 'consolidating_arcs')) {
    return {
      variant: 'processing',
      title: t('chatView.memory'),
      detail: formatRebuildDetail(rebuildStatus, t),
    }
  }

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

/** Merge socket snapshots and reads by server revision, never by arrival order. */
export function mergeCortexActivity(current: CortexActivitySnapshot | null, incoming: CortexActivitySnapshot): CortexActivitySnapshot {
  return current?.chatId === incoming.chatId && current.revision > incoming.revision ? current : incoming
}

function buildActivityNotice(runs: CortexActivityRun[], requestedAt: number | null | undefined, t: Translator, now: number): CortexNotice {
  const requests = runs.flatMap((run) => run.requests)
  const counts = new Map<string, number>()
  for (const request of requests) {
    const key = request.purpose === 'candidate review' && request.phase === 'waiting' ? 'reviewing' : request.phase
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const label = (phase: string) => t(`chatView.cortexActivity.${phase}`)
  const details: string[] = []
  const total = runs.reduce((sum, run) => sum + run.totalChunks, 0)
  const current = runs.reduce((sum, run) => sum + run.completedChunks, 0)
  const totalBatches = runs.reduce((sum, run) => sum + run.totalBatches, 0)
  if (totalBatches) details.push(t('chatView.cortexBatchProgress', {
    current: runs.reduce((sum, run) => sum + run.completedBatches, 0), total: totalBatches,
    queued: Math.max(0, totalBatches - runs.reduce((sum, run) => sum + run.completedBatches + run.failedBatches + run.activeBatches.length, 0)),
  }))
  const failedBatches = runs.reduce((sum, run) => sum + run.failedBatches, 0)
  if (failedBatches) details.push(t('chatView.cortexFailedBatches', { count: failedBatches }))
  if (total) details.push(t('chatView.cortexChunks', { current, total }).replace(/^,\s*/, ''))
  for (const phase of ['queued', 'waiting', 'thinking', 'responding', 'reviewing']) {
    if (counts.has(phase)) details.push(`${counts.get(phase)} ${label(phase)}`)
  }
  if (!requests.length) {
    const phase = runs.some((run) => run.phase.startsWith('consolidating')) ? 'consolidating'
      : runs.some((run) => run.activeBatches.some((batch) => batch.phase === 'persisting') || run.phase === 'persisting') ? 'saving'
      : runs.some((run) => run.startedAt) ? 'preparing' : 'queued'
    details.push(label(phase))
  }
  const start = requestedAt ?? Math.min(...runs.map((run) => run.clientRequestedAt ?? run.requestedAt))
  const elapsed = t('chatView.cortexElapsed', { seconds: Math.max(0, Math.floor((now - start) / 1000)) })
  const batches = runs.flatMap((run) => run.activeBatches.map((batch) => {
    const batchRequests = run.requests.filter((request) => request.batch === batch.batch)
    const phases = [...new Set(batchRequests.map((request) => request.purpose === 'candidate review' && request.phase === 'waiting' ? 'reviewing' : request.phase))]
    const phase = phases[0] ?? (batch.phase === 'persisting' ? 'saving' : 'preparing')
    return { id: `${run.id}:${batch.batch}`, phase,
      label: t('chatView.cortexBatchActivity', { batch: batch.batch, phase: phases.length ? phases.map(label).join(' / ') : label(phase) }),
      detail: [t('chatView.cortexBatchChunks', { count: batch.chunks }), ...batchRequests.map((request) => request.model).filter(Boolean)].join(' · '),
    }
  }))
  return { variant: 'processing', title: t('chatView.memory'), detail: details.join(' · '), elapsed, batches,
    percent: total > 0 && !runs.some((run) => run.phase.startsWith('consolidating')) ? Math.round(current / total * 100) : undefined }
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
