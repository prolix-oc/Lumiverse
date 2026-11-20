import i18n from '@/i18n'
import type { WorldBookEntry, WorldBookReindexProgress, WorldBookVectorIndexStatus } from '@/types/api'

const statusKey = (status: WorldBookVectorIndexStatus) =>
  `worldBookPanel.entryEditor.vectorStatus.${status === 'not_enabled' ? 'notEnabled' : status}` as const

export function getVectorIndexStatusLabel(status: WorldBookVectorIndexStatus): string {
  return i18n.t(statusKey(status), { ns: 'panels' })
}

export function getVectorIndexStatusDescription(entry: WorldBookEntry): string {
  const t = (key: string, opts?: Record<string, unknown>) =>
    i18n.t(`worldBookPanel.entryEditor.vectorStatus.${key}`, { ns: 'panels', ...opts })

  if (!entry.vectorized) {
    return t('off')
  }
  if (entry.vector_index_status === 'indexed') {
    return entry.vector_indexed_at
      ? t('indexedAt', { date: new Date(entry.vector_indexed_at * 1000).toLocaleString() })
      : t('indexedReady')
  }
  if (entry.vector_index_status === 'error') {
    return entry.vector_index_error || t('lastFailed')
  }
  if (entry.disabled) {
    return t('disabledEntry')
  }
  if (!(entry.content || '').trim()) {
    return t('needsContent')
  }
  return t('reindexNeeded')
}

export function formatWorldBookReindexStatus(progress: WorldBookReindexProgress): string {
  const t = (key: string, opts?: Record<string, unknown>) =>
    i18n.t(`worldBookPanel.reindexStatus.${key}`, { ns: 'panels', ...opts })

  const skipped = progress.skipped_not_enabled + progress.skipped_disabled_or_empty
  const parts = [
    t('progress', { current: progress.current, total: progress.total }),
    t('eligible', { count: progress.eligible }),
    t('indexed', { count: progress.indexed }),
  ]

  if (skipped > 0) {
    parts.push(t('skipped', { count: skipped }))
  }
  if (progress.removed > 0) {
    parts.push(t('cleaned', { count: progress.removed }))
  }
  if (progress.failed > 0) {
    parts.push(t('failed', { count: progress.failed }))
  }

  return parts.join(' | ')
}
