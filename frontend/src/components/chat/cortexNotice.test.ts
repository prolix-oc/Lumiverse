import { describe, expect, test } from 'bun:test'
import type { CortexIngestionStatus } from '@/api/memory-cortex'
import en from '../../i18n/locales/en/chat.json'
import {
  CORTEX_ERROR_NOTICE_VISIBLE_MS,
  buildCortexNotice,
  cortexErrorNoticeRemainingMs,
  hideDismissedCortexError,
  normalizeRebuildStatus,
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
