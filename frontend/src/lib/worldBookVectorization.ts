import type { WorldBookEntry, WorldBookReindexProgress, WorldBookVectorIndexStatus } from '@/types/api'

export function getVectorIndexStatusLabel(status: WorldBookVectorIndexStatus): string {
  switch (status) {
    case 'indexed':
      return 'Indexed'
    case 'pending':
      return 'Pending'
    case 'error':
      return 'Error'
    case 'not_enabled':
    default:
      return 'Not enabled'
  }
}

export function getVectorIndexStatusDescription(entry: WorldBookEntry): string {
  if (!entry.vectorized) {
    return 'Semantic activation is off for this entry.'
  }
  if (entry.vector_index_status === 'indexed') {
    return entry.vector_indexed_at
      ? `Indexed ${new Date(entry.vector_indexed_at * 1000).toLocaleString()}.`
      : 'Indexed and ready for semantic activation.'
  }
  if (entry.vector_index_status === 'error') {
    return entry.vector_index_error || 'The last indexing attempt failed.'
  }
  if (entry.disabled) {
    return 'This entry is disabled, so it will not be indexed until it is enabled again.'
  }
  if (!(entry.content || '').trim()) {
    return 'This entry needs content before it can be indexed.'
  }
  return 'Reindex this book after semantic changes so this entry can be searched.'
}

export function formatWorldBookReindexStatus(progress: WorldBookReindexProgress): string {
  const skipped = progress.skipped_not_enabled + progress.skipped_disabled_or_empty
  const parts = [
    `${progress.current}/${progress.total}`,
    `${progress.eligible} eligible`,
    `${progress.indexed} indexed`,
  ]

  if (skipped > 0) {
    parts.push(`${skipped} skipped`)
  }
  if (progress.removed > 0) {
    parts.push(`${progress.removed} cleaned`)
  }
  if (progress.failed > 0) {
    parts.push(`${progress.failed} failed`)
  }

  return parts.join(' | ')
}
