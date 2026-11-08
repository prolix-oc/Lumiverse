import { regexApi } from '@/api/regex'
import type { RegexScript } from '@/types/regex'

// Client-side evidence for isolated display-regex execution. Quarantine is the
// only signal here because it is the only one that changes execution: a script
// that hung the worker gets skipped until the user clears it. Successful
// timings were deliberately dropped rather than persisted — one fast input
// cannot prove a backtracking pattern is safe on the next input, so ok-evidence
// could never promote a script to a cheaper tier and only produced write
// traffic plus metadata nobody read.
export interface RegexScriptEvidence {
  quarantined?: boolean
}

export type RegexExecTier = 'quarantined' | 'worker'

// Session-scoped local mutations, keyed by definition. Untouched scripts read
// stored evidence directly: evidence writes do not bump updated_at, so caching
// those reads would hide metadata-only refetches. Local mutations take priority
// over server snapshots of the same definition while persistence catches up.
const sessionEvidence = new Map<string, { definitionKey: string; evidence: RegexScriptEvidence }>()

// Quarantine is mutated from the async pipeline, outside React's knowledge, so
// the panel needs an explicit subscription to re-render. A version counter is
// enough: components read the current state through isRegexScriptQuarantined()
// and only need a signal that something changed. Storing snapshots per script
// id was rejected — useSyncExternalStore requires a referentially stable
// snapshot, and per-script objects would have to be memoised anyway.
let evidenceVersion = 0
const evidenceListeners = new Set<() => void>()

// Once-per-script toast dedupe for skipped scripts. This lives here rather than
// in pipeline.ts because clearRegexScriptQuarantine() has to reset it, and
// pipeline.ts already imports this module — importing back the other way would
// create a cycle. pipeline.ts still owns the actual warning it emits.
type RegexSkipKind = 'quarantined' | 'unavailable'
const announcedSkipKeys = new Map<string, Set<RegexSkipKind>>()

function definitionKey(script: RegexScript): string {
  return JSON.stringify([
    script.updated_at,
    script.find_regex,
    script.replace_string,
    script.flags,
    script.trim_strings,
    script.substitute_macros,
    script.actions,
    script.metadata?.match_actions,
  ])
}

function readStoredEvidence(script: RegexScript): RegexScriptEvidence {
  const raw = script.metadata?.regex_evidence
  if (!raw || typeof raw !== 'object') return {}
  const evidence: RegexScriptEvidence = {}
  if (raw.quarantined === true) evidence.quarantined = true
  return evidence
}

function notifyEvidenceChanged(): void {
  evidenceVersion += 1
  // Copy first: a listener may unsubscribe while being notified.
  for (const listener of [...evidenceListeners]) listener()
}

export function subscribeRegexEvidence(listener: () => void): () => void {
  evidenceListeners.add(listener)
  return () => {
    evidenceListeners.delete(listener)
  }
}

export function getRegexEvidenceVersion(): number {
  return evidenceVersion
}

export function readRegexScriptEvidence(script: RegexScript): RegexScriptEvidence {
  const key = definitionKey(script)
  const entry = sessionEvidence.get(script.id)
  if (entry?.definitionKey === key) return entry.evidence
  // Reads must not overwrite a local mutation made with another snapshot.
  // Multiple message renders can still hold older versions of the same row.
  return readStoredEvidence(script)
}

export function getRegexExecTier(script: RegexScript): { tier: RegexExecTier; reason: string } {
  const evidence = readRegexScriptEvidence(script)
  if (evidence.quarantined) return { tier: 'quarantined', reason: 'quarantined' }
  return { tier: 'worker', reason: 'user-authored regexes require isolated execution' }
}

export function isRegexScriptQuarantined(script: RegexScript): boolean {
  return readRegexScriptEvidence(script).quarantined === true
}

// Warn once per script and skip kind per session instead of on every message.
// A temporary executor failure must not suppress a later quarantine warning.
export function shouldAnnounceRegexSkip(scriptId: string, kind: RegexSkipKind = 'quarantined'): boolean {
  const kinds = announcedSkipKeys.get(scriptId) ?? new Set<RegexSkipKind>()
  if (kinds.has(kind)) return false
  kinds.add(kind)
  announcedSkipKeys.set(scriptId, kinds)
  return true
}

export function quarantineRegexScript(script: RegexScript): void {
  const evidence = readRegexScriptEvidence(script)
  if (evidence.quarantined) return
  evidence.quarantined = true
  sessionEvidence.set(script.id, { definitionKey: definitionKey(script), evidence })
  void regexApi.reportEvidence(script.id, { quarantined: true }).catch(() => {
    // Best-effort persistence: extension-owned scripts may reject the write.
    // The session overlay keeps tiering correct regardless.
  })
  notifyEvidenceChanged()
}

/**
 * User-facing escape hatch from quarantine. The overlay is cleared immediately
 * and the persisted flag is deleted server-side (report-evidence removes the
 * key on `quarantined: false`). The returned promise rejects on a failed write
 * so the caller can surface it.
 *
 * The overlay is cleared before the write settles on purpose. Waiting for the
 * server would leave the script skipped for the rest of the session on a failed
 * write even though the user explicitly asked to retry it; clearing first means
 * the retry happens, and a script that hangs again simply re-quarantines.
 */
export function clearRegexScriptQuarantine(script: RegexScript): Promise<void> {
  const evidence = readRegexScriptEvidence(script)
  delete evidence.quarantined
  sessionEvidence.set(script.id, { definitionKey: definitionKey(script), evidence })
  // A deliberate retry earns a fresh warning if the script hangs again.
  announcedSkipKeys.delete(script.id)
  notifyEvidenceChanged()
  return regexApi.reportEvidence(script.id, { quarantined: false }).then(() => undefined)
}

export function resetRegexSkipAnnouncementsForTests(): void {
  announcedSkipKeys.clear()
}

export function resetRegexEvidenceForTests(): void {
  sessionEvidence.clear()
  announcedSkipKeys.clear()
}
