import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { RegexScript } from '@/types/regex'

const evidenceReports: Array<{ id: string; payload: Record<string, unknown> }> = []
let reportEvidenceImpl: (id: string, payload: Record<string, unknown>) => Promise<unknown> = async () => ({})

mock.module('@/api/regex', () => ({
  regexApi: {
    reportEvidence: (id: string, payload: Record<string, unknown>) => {
      evidenceReports.push({ id, payload })
      return reportEvidenceImpl(id, payload)
    },
    reportPerformance: async () => ({}), get: async () => ({}), update: async () => ({}),
  },
}))

const {
  clearRegexScriptQuarantine,
  getRegexEvidenceVersion,
  getRegexExecTier,
  isRegexScriptQuarantined,
  quarantineRegexScript,
  readRegexScriptEvidence,
  resetRegexEvidenceForTests,
  shouldAnnounceRegexSkip,
  subscribeRegexEvidence,
} = await import('./evidence')

function script(id: string, overrides: Partial<RegexScript> = {}): RegexScript {
  return {
    id, user_id: 'user', name: id, script_id: id, find_regex: 'x', replace_string: 'y',
    actions: [], flags: 'g', placement: ['ai_output'], scope: 'global', scope_id: null,
    target: ['display'], min_depth: null, max_depth: null, trim_strings: [], run_on_edit: false,
    substitute_macros: 'none', disabled: false, sort_order: 0, description: '', folder: '', metadata: {},
    created_at: 1, updated_at: 1, ...overrides,
  }
}

beforeEach(() => {
  reportEvidenceImpl = async () => ({})
})

afterEach(() => {
  resetRegexEvidenceForTests()
  evidenceReports.length = 0
})

describe('clearRegexScriptQuarantine', () => {
  test('observes quarantine-only metadata updates without a definition or timestamp change', () => {
    const original = script('remote-update')
    expect(isRegexScriptQuarantined(original)).toBe(false)

    // Evidence writes deliberately do not bump updated_at. A WS refetch must
    // still expose the badge and recovery action after a prior healthy read.
    const quarantined = { ...original, metadata: { regex_evidence: { quarantined: true } } }
    expect(isRegexScriptQuarantined(quarantined)).toBe(true)
    expect(getRegexExecTier(quarantined).tier).toBe('quarantined')

    // A clear in another tab is also a metadata-only update.
    expect(isRegexScriptQuarantined({ ...original })).toBe(false)
    expect(evidenceReports).toEqual([])
  })

  test('persisted and stale snapshots cannot overwrite local quarantine or an explicit retry', async () => {
    const original = script('snapshots')
    quarantineRegexScript(original)

    const persisted = { ...original, metadata: { regex_evidence: { quarantined: true } } }
    expect(isRegexScriptQuarantined(persisted)).toBe(true)
    expect(isRegexScriptQuarantined(original)).toBe(true)

    await clearRegexScriptQuarantine(persisted)
    expect(isRegexScriptQuarantined({ ...original })).toBe(false)
    expect(isRegexScriptQuarantined(persisted)).toBe(false)
  })

  test('clears the session overlay, persists quarantined:false, and restores the worker tier', async () => {
    const hung = script('hung', { metadata: { regex_evidence: { quarantined: true } } })
    expect(isRegexScriptQuarantined(hung)).toBe(true)
    expect(getRegexExecTier(hung)).toEqual({ tier: 'quarantined', reason: 'quarantined' })

    await clearRegexScriptQuarantine(hung)

    // The overlay wins over the stale server row until the panel refetches.
    expect(readRegexScriptEvidence(hung)).toEqual({})
    expect(isRegexScriptQuarantined(hung)).toBe(false)
    expect(getRegexExecTier(hung)).toEqual({
      tier: 'worker',
      reason: 'user-authored regexes require isolated execution',
    })
    expect(evidenceReports).toEqual([{ id: 'hung', payload: { quarantined: false } }])
  })

  test('rejects when the persistence write fails, leaving the overlay cleared so the retry still happens', async () => {
    const hung = script('hung-write-fail')
    quarantineRegexScript(hung)
    reportEvidenceImpl = async () => { throw new Error('read-only script') }

    await expect(clearRegexScriptQuarantine(hung)).rejects.toThrow('read-only script')

    expect(isRegexScriptQuarantined(hung)).toBe(false)
    expect(evidenceReports).toEqual([
      { id: 'hung-write-fail', payload: { quarantined: true } },
      { id: 'hung-write-fail', payload: { quarantined: false } },
    ])
  })

  test('resets the skip announcement so a re-quarantine warns again', async () => {
    const hung = script('hung-twice')
    quarantineRegexScript(hung)
    expect(shouldAnnounceRegexSkip(hung.id)).toBe(true)
    expect(shouldAnnounceRegexSkip(hung.id)).toBe(false)

    await clearRegexScriptQuarantine(hung)

    // A deliberate retry that hangs again is news, not noise.
    quarantineRegexScript(hung)
    expect(shouldAnnounceRegexSkip(hung.id)).toBe(true)
    expect(shouldAnnounceRegexSkip(hung.id)).toBe(false)
    expect(evidenceReports).toEqual([
      { id: 'hung-twice', payload: { quarantined: true } },
      { id: 'hung-twice', payload: { quarantined: false } },
      { id: 'hung-twice', payload: { quarantined: true } },
    ])
  })

  test('notifies subscribers on both quarantine and clear so React can re-render', async () => {
    const hung = script('hung-observable')
    const versions: number[] = []
    const unsubscribe = subscribeRegexEvidence(() => versions.push(getRegexEvidenceVersion()))
    const before = getRegexEvidenceVersion()

    quarantineRegexScript(hung)
    await clearRegexScriptQuarantine(hung)
    // Reads never bump the version: they run during render.
    readRegexScriptEvidence(hung)
    unsubscribe()
    quarantineRegexScript(script('after-unsubscribe'))

    expect(versions).toEqual([before + 1, before + 2])
    expect(getRegexEvidenceVersion()).toBe(before + 3)
  })
})
