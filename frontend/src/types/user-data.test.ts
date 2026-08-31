import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isUserDataJobActive,
  isUserDataJobCancellable,
  normalizeUserDataApiFailure,
  normalizeUserDataCommand,
  normalizeUserDataJob,
  normalizeUserDataProgress,
  normalizeUserDataFailure,
  parseDecryptionTicket,
  USER_DATA_FAILURE_CODES,
  USER_DATA_JOB_STATUSES,
  UserDataProtocolError,
} from './user-data'

function statusJob(status: string, overrides: Record<string, unknown> = {}) {
  return normalizeUserDataJob({
    jobId: 'import-1',
    status,
    summary: { chats: { imported: 2, skipped: 1 } },
    ...overrides,
  })
}

describe('bounded user-data portability contracts', () => {
  test('reconnects a persisted running job without treating it as a fresh upload', () => {
    const job = statusJob('running', { progress: { phase: 'files', processed: 3, total: 8 } })
    expect(job.jobId).toBe('import-1')
    expect(job.progress?.processed).toBe(3)
    expect(isUserDataJobActive(job.status)).toBe(true)
  })
  test('keeps cancellation fencing visible before cleanup completion', () => {
    const job = statusJob('cancelling')
    expect(job.status).toBe('cancelling')
    expect(isUserDataJobActive(job.status)).toBe(true)
    expect(isUserDataJobCancellable(job.status)).toBe(false)
  })

  test('keeps cleanup-pending receipt projection visible while polling and non-cancellable', () => {
    const job = statusJob('cleanup_pending', {
      summary: {
        tables: { chats: { imported: 1, skipped: 0 } },
        files: {},
        secrets: { imported: 0, skipped: 0 },
        vectors: { imported: 0, skipped: 0, rebuildRequired: true, projectionPending: true },
      },
    })
    expect(job.status).toBe('cleanup_pending')
    expect(isUserDataJobActive(job.status)).toBe(true)
    expect(isUserDataJobCancellable(job.status)).toBe(false)
    expect(job.summary.vectors).toEqual({ status: 'rebuild_required', imported: 0, skipped: 0 })
  })


  test('normalizes a durable cancellation response', () => {
    const command = normalizeUserDataCommand({ status: 'cancelled' })
    expect(command.accepted).toBe(true)
    expect(command.status).toBe('cancelled')
  })

  test('keeps a ticket replay response stable and non-disclosing', () => {
    const failure = normalizeUserDataFailure({ code: 'replayed', message: 'ticket has already been consumed' })
    expect(failure).toEqual({ code: 'replayed', message: 'ticket has already been consumed' })
    expect(normalizeUserDataFailure({ code: 'private_server_detail' }, 'ticket_submission_failed')).toEqual({ code: 'ticket_submission_failed', message: null })
  })
  test('normalizes command HTTP status fields without exposing transport details', () => {
    expect(normalizeUserDataApiFailure({ body: { status: 'too_late', error: 'internal detail' } }, 'network')).toEqual({
      code: 'too_late',
      message: 'internal detail',
    })
    expect(normalizeUserDataApiFailure({ body: { status: 503, error: 'service unavailable' } }, 'network')).toEqual({
      code: 'network',
      message: 'service unavailable',
    })
  })


  test('normalizes a restart receipt into canonical table/file summaries', () => {
    const job = statusJob('committed', {
      summary: {
        tables: { chats: { imported: 4, skipped: 0 } },
        files: { 'images/avatar.png': 1 },
        secrets: { imported: 2, skipped: 1 },
      },
      fileSummary: { 'images/avatar.png': 1, 'audio/voice.ogg': 1 },
    })
    expect(job.status).toBe('complete')
    expect(job.summary.tables).toEqual({ chats: { imported: 4, skipped: 0 } })
    expect(job.summary.files).toEqual({ 'images/avatar.png': 1, 'audio/voice.ogg': 1 })
    expect(job.summary.secrets).toEqual({ imported: 2, skipped: 1 })
  })
  test('uses one bounded progress normalizer for reconnect and WebSocket payloads', () => {
    expect(normalizeUserDataProgress({ phase: 'files', processed: 2, total: 3 })).toEqual({
      phase: 'files',
      table: null,
      processed: 2,
      total: 3,
    })
    expect(() => normalizeUserDataProgress({ phase: 'files', processed: 4, total: 3 })).toThrow(UserDataProtocolError)
    expect(() => normalizeUserDataProgress({ phase: 'x'.repeat(257) })).toThrow(UserDataProtocolError)
  })

  test('rejects oversized nested summaries and malformed tickets before API submission', () => {
    const huge = Object.fromEntries(Array.from({ length: 1_025 }, (_, index) => [`table-${index}`, { imported: 1, skipped: 0 }]))
    expect(() => statusJob('running', { summary: huge })).toThrow(UserDataProtocolError)
    expect(() => parseDecryptionTicket('{"kind":"lumiverse-decryption-ticket"}')).toThrow(UserDataProtocolError)
  })

  test('keeps every portability string in all six locales and covers every stable code', () => {
    const locales = ['en', 'zh', 'zh-TW', 'ja', 'fr', 'it']
    const load = (locale: string): Record<string, unknown> => {
      const path = resolve(import.meta.dir, `../i18n/locales/${locale}/settings.json`)
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { dataPortability: Record<string, unknown> }
      return parsed.dataPortability
    }
    const leafKeys = (value: unknown, prefix = ''): string[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
      return Object.entries(value).flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key))
    }
    const expected = leafKeys(load('en')).sort()
    for (const locale of locales) expect(leafKeys(load(locale)).sort()).toEqual(expected)
    const en = load('en') as unknown as { failureReasons: Record<string, string>; statuses: Record<string, string> }
    for (const code of USER_DATA_FAILURE_CODES) expect(typeof en.failureReasons[code]).toBe('string')
    for (const status of USER_DATA_JOB_STATUSES) expect(typeof en.statuses[status]).toBe('string')
  })
})
