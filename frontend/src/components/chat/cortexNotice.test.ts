import { describe, expect, test } from 'bun:test'
import type { CortexIngestionStatus, CortexActivityRun, CortexActivitySnapshot } from '@/api/memory-cortex'
import en from '../../i18n/locales/en/chat.json'
import {
  CORTEX_ERROR_NOTICE_VISIBLE_MS,
  buildCortexNotice,
  cortexErrorNoticeRemainingMs,
  hideDismissedCortexError,
  normalizeRebuildStatus,
  mergeCortexActivity,
} from './cortexNotice'

const t = (key: string, options?: Record<string, unknown>): string => {
  const value = key.split('.').reduce<unknown>((current, part) => (
    current && typeof current === 'object'
      ? (current as Record<string, unknown>)[part]
      : undefined
  ), en)
  if (typeof value !== 'string') return key
  return Object.entries(options ?? {}).reduce(
    (text, [name, replacement]) => text.replaceAll(`{{${name}}}`, String(replacement)),
    value,
  )
}

function ingestion(overrides: Partial<CortexIngestionStatus> = {}): CortexIngestionStatus {
  return {
    chatId: 'chat-1',
    status: 'processing',
    phase: 'sidecar',
    chunkId: 'chunk-1',
    startedAt: 1_000,
    updatedAt: 2_000,
    pendingJobs: 1,
    ...overrides,
  }
}

describe('Cortex chat notices', () => {
  const activity = (overrides: Partial<CortexActivityRun> = {}): CortexActivitySnapshot => ({
    chatId: 'chat-1', revision: 1, runs: [{ id: 'run-1', chatId: 'chat-1', kind: 'rebuild', status: 'processing',
      phase: 'starting', requestedAt: 1_000, updatedAt: 1_000, completedChunks: 0, totalChunks: 0,
      completedBatches: 0, failedBatches: 0, totalBatches: 0, activeBatches: [], requests: [], ...overrides }],
  })

  test('shows the user request immediately, before server progress or provider dispatch', () => {
    const notice = buildCortexNotice(null, null, t, null, 1_000, 3_000)
    expect(notice?.detail).toBe('Queued')
    expect(notice?.elapsed).toBe('2s elapsed')
    expect(notice?.percent).toBeUndefined()
  })

  test('shows simultaneous batch states, queued work and processed chunks independently', () => {
    const snapshot = activity({ totalChunks: 17, completedChunks: 5, totalBatches: 4, completedBatches: 1,
      activeBatches: [{ batch: 2, chunks: 5, phase: 'sidecar' }, { batch: 3, chunks: 5, phase: 'sidecar' }],
      requests: [
        { id: 'r2', batch: 2, chunks: 5, purpose: 'analysis', phase: 'thinking', model: 'model-a', queuedAt: 1_000, updatedAt: 2_000 },
        { id: 'r3', batch: 3, chunks: 5, purpose: 'analysis', phase: 'responding', model: 'model-b', queuedAt: 1_000, updatedAt: 2_000 },
      ],
    })
    const notice = buildCortexNotice(null, { status: 'processing', phase: 'ingesting' }, t, snapshot, null, 11_000)!
    expect(notice.detail).toBe('1/4 batches · 1 queued · 5/17 chunks · 1 Thinking · 1 Responding')
    expect(notice.elapsed).toBe('10s elapsed')
    expect(notice.percent).toBe(29)
    expect(notice.batches?.map((batch) => batch.label)).toEqual(['Batch 2 · Thinking', 'Batch 3 · Responding'])
    expect(notice.batches?.[0].detail).toBe('Chunks: 5 · model-a')
  })

  test('labels Decision review honestly and keeps a batch active after its response until persistence finishes', () => {
    const snapshot = activity({ totalChunks: 5, totalBatches: 1,
      activeBatches: [{ batch: 1, chunks: 5, phase: 'persisting' }],
      requests: [{ id: 'review', batch: 1, chunks: 5, purpose: 'candidate review', phase: 'waiting', queuedAt: 1_000, updatedAt: 2_000 }],
    })
    expect(buildCortexNotice(null, null, t, snapshot)?.detail).toContain('1 Reviewing')
    snapshot.runs[0].requests = []
    const saving = buildCortexNotice(null, null, t, snapshot)!
    expect(saving.detail).toContain('Saving')
    expect(saving.percent).toBe(0)
    expect(saving.batches?.[0].label).toBe('Batch 1 · Saving')
  })

  test('preserves the initiating click time after the server acknowledges a queued request', () => {
    const snapshot = activity({ requestedAt: 3_000 })
    expect(buildCortexNotice(null, null, t, snapshot, null, 10_000, 1_000)?.elapsed).toBe('9s elapsed')
    snapshot.runs[0].clientRequestedAt = 1_000
    expect(buildCortexNotice(null, null, t, snapshot, null, 10_000)?.elapsed).toBe('9s elapsed')
  })

  test('does not mislabel a failed batch as queued while another batch continues', () => {
    const snapshot = activity({ totalBatches: 2, failedBatches: 1,
      activeBatches: [{ batch: 2, chunks: 5, phase: 'preparing' }],
    })
    const notice = buildCortexNotice(null, null, t, snapshot)!
    expect(notice.detail).toContain('0/2 batches · 0 queued · Failed batches: 1')
    expect(notice.batches?.[0].label).toBe('Batch 2 · Preparing')
  })

  test('ignores stale reads and socket messages after completion', () => {
    const stale = activity()
    const complete = { ...activity({ status: 'complete' }), revision: 2 }
    expect(mergeCortexActivity(complete, stale)).toBe(complete)
    expect(buildCortexNotice(null, null, t, mergeCortexActivity(complete, stale))).toBeNull()
    expect(mergeCortexActivity(stale, complete)).toBe(complete)
  })

  test('labels passive Cortex rebuilds as Cortex, not LTCM embedding work', () => {
    const notice = buildCortexNotice(null, {
      chatId: 'chat-1',
      status: 'processing',
      source: 'warmup',
      current: 2,
      total: 4,
      percent: 50,
    }, t)

    expect(notice?.detail).toBe('Preparing Memory Cortex, 2/4 chunks')
    expect(notice?.detail).not.toContain('Long-Term Chat Memory')
  })

  test('uses sidecar wording only for an actual Cortex ingestion phase', () => {
    expect(buildCortexNotice(ingestion(), null, t)?.detail).toBe('Running sidecar analysis')
  })

  for (const [phase, detail] of [
    ['consolidating', 'Consolidating scene memories'],
    ['consolidating_arcs', 'Consolidating arc memories'],
  ]) {
    test(`shows ${phase} instead of completed chunk progress, including during concurrent ingestion`, () => {
      for (const activeIngestion of [null, ingestion()]) {
        const notice = buildCortexNotice(activeIngestion, {
          chatId: 'chat-1',
          status: 'processing',
          current: 233,
          total: 233,
          percent: 100,
          phase,
        }, t)

        expect(notice?.detail).toBe(detail)
        expect(notice?.percent).toBeUndefined()
      }
    })
  }

  test('gives terminal errors a stable occurrence key and bounded visibility', () => {
    const notice = buildCortexNotice(ingestion({
      status: 'error',
      phase: 'error',
      updatedAt: 5_000,
      pendingJobs: 0,
      error: 'sidecar_timeout',
    }), null, t)!

    expect(notice.detail).toBe('Memory Cortex processing failed.')
    expect(notice.errorKey).toBe('ingestion:chat-1:5000:sidecar_timeout')
    expect(cortexErrorNoticeRemainingMs(notice, 5_000)).toBe(CORTEX_ERROR_NOTICE_VISIBLE_MS)
    expect(cortexErrorNoticeRemainingMs(notice, 5_000 + CORTEX_ERROR_NOTICE_VISIBLE_MS)).toBe(0)
    expect(hideDismissedCortexError(
      notice,
      null,
      5_000 + CORTEX_ERROR_NOTICE_VISIBLE_MS,
    )).toBeNull()
    expect(hideDismissedCortexError(notice, notice.errorKey!, 5_000)).toBeNull()
  })

  test('does not render idle or completed rebuild state', () => {
    expect(normalizeRebuildStatus({ status: 'idle' })).toBeNull()
    expect(normalizeRebuildStatus({ status: 'complete' })).toBeNull()
  })
})
