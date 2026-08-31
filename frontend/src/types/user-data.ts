/**
 * Public, bounded user-data portability contracts.
 *
 * The API may return either a live progress summary or the receipt envelope
 * persisted by the import transaction. Consumers never inspect that envelope
 * directly; normalizeUserDataJob exposes one canonical summary shape.
 */

export const USER_DATA_LIMITS: {
  maxJobs: number
  maxSummaryEntries: number
  maxFileEntries: number
  maxManifestCounts: number
  maxManifestMissingFiles: number
  maxManifestEntries: number
  maxStringBytes: number
  maxJobIdBytes: number
  maxFailureMessageBytes: number
  maxTicketBytes: number
  maxArchiveUploadBytes: number
  maxCounter: number
} = Object.freeze({
  maxJobs: 128,
  maxSummaryEntries: 1_024,
  maxFileEntries: 1_024,
  maxManifestCounts: 2_048,
  maxManifestMissingFiles: 1_024,
  maxManifestEntries: 4_096,
  maxStringBytes: 4_096,
  maxJobIdBytes: 256,
  maxFailureMessageBytes: 512,
  maxTicketBytes: 256 * 1_024,
  maxArchiveUploadBytes: 8 * 1024 * 1024 * 1024,
  maxCounter: 2_000_000_000,
})

/**
 * Schema version written into new .lvbak manifests.
 * Keep equal to src/services/user-data/manifest.ts `ARCHIVE_SCHEMA_VERSION`.
 */
export const ARCHIVE_SCHEMA_VERSION = 3

/**
 * The complete set of stable portability failure reasons. `unknown` is the
 * sentinel used when the server sends a code this build does not know; every
 * other entry has a matching `settings:dataPortability.failureReasons` string
 * in all six locales.
 */
export const USER_DATA_FAILURE_CODES = [
  'unknown',
  'malformed_response',
  'archive_validation_failed',
  'not_zip',
  'size',
  'no_manifest',
  'bad_manifest',
  'archive_identity_mismatch',
  'upload_failed',
  'upload_timeout',
  'upload_aborted',
  'import_start_failed',
  'import_failed',
  'integrity_failure',
  'multipart_not_supported',
  'export_capacity',
  'manual_recovery_required',
  'process_interrupted',
  'cancelled',
  'too_late',
  'not_found',
  'ticket_required',
  'ticket_invalid',
  'ticket_submission_failed',
  'ticket_gate_conflict',
  'replayed',
  'stale',
  'wrong_issuer',
  'invalid_issuer_instance',
  'unsupported_version',
  'archive_mismatch',
  'binding_mismatch',
  'network',
] as const

export type UserDataFailureCode = (typeof USER_DATA_FAILURE_CODES)[number]

export interface UserDataFailure {
  code: UserDataFailureCode
  /** A bounded, user-safe message supplied by the API. */
  message: string | null
}

/**
 * Every durable import state the API can project. `committed` is the server's
 * receipt state and is normalized to `complete` on the way in; every entry here
 * has a `settings:dataPortability.statuses` label in all six locales.
 */
export const USER_DATA_JOB_STATUSES = [
  'queued',
  'validating',
  'awaiting_ticket',
  'running',
  'installing',
  'ready',
  'committing',
  'cancelling',
  'cleanup_pending',
  'complete',
  'failed',
  'cancelled',
] as const

export type UserDataJobStatus = (typeof USER_DATA_JOB_STATUSES)[number]

export interface UserDataProgress {
  phase: string
  table: string | null
  processed: number | null
  total: number | null
}

export const USER_DATA_RUNTIME_POLICY_VERSION = 1 as const
export const USER_DATA_RUNTIME_POLICY_SOURCES = [
  'authenticated_one_turn',
  'durable_chat_override',
  'reviewed_preset_default',
  'response_fallback',
  'host_cap',
  'host_rejected',
] as const
export const USER_DATA_RUNTIME_POLICY_SCOPES = ['turn', 'chat', 'preset', 'fallback', 'host'] as const
export const USER_DATA_RUNTIME_POLICY_AVAILABILITY = ['available', 'unavailable', 'stale', 'invalid', 'denied', 'omitted'] as const
export type UserDataRuntimePolicySource = (typeof USER_DATA_RUNTIME_POLICY_SOURCES)[number]
export type UserDataRuntimePolicyScope = (typeof USER_DATA_RUNTIME_POLICY_SCOPES)[number]
export type UserDataRuntimePolicyAvailability = (typeof USER_DATA_RUNTIME_POLICY_AVAILABILITY)[number]

export interface UserDataRuntimePolicyV1 {
  version: typeof USER_DATA_RUNTIME_POLICY_VERSION
  authoredValue: 'response' | 'agentic'
  effectiveValue: 'response' | 'agentic'
  source: UserDataRuntimePolicySource
  scope: UserDataRuntimePolicyScope
  cap: {
    authority: 'host'
    allowedModes: ('response' | 'agentic')[]
    reasonCode: string | null
  }
  availability: {
    state: UserDataRuntimePolicyAvailability
    reasonCode: string | null
  }
  presetRevision: number | string | null
  transientSelection: {
    mode: 'response' | 'agentic'
    turnFence: number | string
    authenticated: true
  } | null
  durableChatOverride: {
    mode: 'response' | 'agentic' | null
    revision: number
    state: 'ready' | 'review_required' | 'repair_required'
    reviewCode: string | null
    acknowledged: boolean
  } | null
  repairAcknowledgement: {
    state: 'not_required' | 'required' | 'acknowledged'
    presetRevision: number | string | null
    reasonCode: string | null
    acknowledgedAt: number | null
  }
  nextTurnOnly: true
}

export interface UserDataManifest {
  schemaVersion: number
  exportedAt: number
  archiveId: string
  producerVersion: string | null
  includeVectors: boolean
  embeddingConfig: {
    provider: string | null
    model: string | null
    dimension: number | null
  }
  counts: Record<string, number>
  missingFiles: string[]
  hasEncryptedSecrets: boolean
  secretsCount: number
  registryVersion: number | null
  snapshotId: string | null
  entryCount: number | null
  runtimePolicy?: UserDataRuntimePolicyV1 | null
}

export interface UserDataSummaryCounts {
  imported: number
  skipped: number
}

export interface UserDataVectorSummary {
  status: 'included' | 'rebuild_required' | 'skipped' | 'unknown'
  imported: number
  skipped: number
}

/** Canonical receipt/progress projection consumed by the UI. */
export interface UserDataReceiptSummary {
  tables: Record<string, UserDataSummaryCounts>
  files: Record<string, number>
  secrets: UserDataSummaryCounts
  vectors: UserDataVectorSummary | null
}

export interface UserDataJob {
  jobId: string
  archiveId: string | null
  status: UserDataJobStatus
  startedAt: number | null
  finishedAt: number | null
  updatedAt: number | null
  manifest: UserDataManifest | null
  progress: UserDataProgress | null
  summary: UserDataReceiptSummary
  failure: UserDataFailure | null
  ticket: {
    required: boolean
    secretsCount: number
  }
}

export interface UserDataStartImportResponse {
  jobId: string
  status: UserDataJobStatus
}

export interface UserDataExportPrepareResponse {
  archiveId: string
  archiveUrl: string
  archiveFilename: string
  ticketFilename: string | null
  ticket: DecryptionTicket | null
  secretsCount: number
  unreachableSecrets: string[]
}
export interface UserDataCommandResponse {
  accepted: boolean
  status: UserDataJobStatus | 'too_late' | 'not_found' | null
  job: UserDataJob | null
  failure: UserDataFailure | null
}

export interface DecryptionTicket {
  kind: 'lumiverse-decryption-ticket'
  version: 1
  archiveId: string
  issuer: 'lumiverse'
  issuerInstance: string | null
  issuedAt: number
  algorithm: 'AES-256-GCM'
  keyB64: string
  secretsHash: string
}

export class UserDataProtocolError extends Error {
  readonly code: UserDataFailureCode

  constructor(code: UserDataFailureCode, message: string) {
    super(message)
    this.name = 'UserDataProtocolError'
    this.code = code
  }
}

/** Server-sent codes are trusted only when they are one of the stable reasons. */
const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set(
  USER_DATA_FAILURE_CODES.filter((code) => code !== 'unknown'),
)

const textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null

function byteLength(value: string): number {
  return textEncoder ? textEncoder.encode(value).byteLength : value.length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, field: string, limit = USER_DATA_LIMITS.maxStringBytes): string {
  if (typeof value !== 'string' || value.length === 0 || byteLength(value) > limit) {
    throw new UserDataProtocolError('malformed_response', `${field} is invalid`)
  }
  return value
}

function optionalString(value: unknown, field: string, limit = USER_DATA_LIMITS.maxStringBytes): string | null {
  if (value === null || value === undefined) return null
  return boundedString(value, field, limit)
}

function boundedInteger(value: unknown, field: string, max = USER_DATA_LIMITS.maxCounter): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new UserDataProtocolError('malformed_response', `${field} is invalid`)
  }
  return value
}

function optionalTimestamp(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new UserDataProtocolError('malformed_response', `${field} is invalid`)
  }
  return value
}

function boundedMap(value: unknown, field: string, maxEntries: number): Record<string, number> {
  if (!isRecord(value)) throw new UserDataProtocolError('malformed_response', `${field} is invalid`)
  const entries = Object.entries(value)
  if (entries.length > maxEntries) throw new UserDataProtocolError('malformed_response', `${field} is too large`)
  const result: Record<string, number> = {}
  for (const [key, item] of entries) {
    if (!key || byteLength(key) > 512) throw new UserDataProtocolError('malformed_response', `${field} contains an invalid key`)
    result[key] = boundedInteger(item, `${field}.${key}`)
  }
  return result
}

function boundedStringList(value: unknown, field: string, maxEntries: number): string[] {
  if (!Array.isArray(value) || value.length > maxEntries) {
    throw new UserDataProtocolError('malformed_response', `${field} is invalid`)
  }
  return value.map((item, index) => boundedString(item, `${field}[${index}]`, 512))
}

function parseSummaryCounts(value: unknown, field: string): UserDataSummaryCounts {
  if (!isRecord(value)) throw new UserDataProtocolError('malformed_response', `${field} is invalid`)
  return {
    imported: boundedInteger(value.imported, `${field}.imported`),
    skipped: boundedInteger(value.skipped, `${field}.skipped`),
  }
}

function emptySummary(): UserDataReceiptSummary {
  return { tables: {}, files: {}, secrets: { imported: 0, skipped: 0 }, vectors: null }
}

function normalizeVector(value: unknown): UserDataVectorSummary | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw new UserDataProtocolError('malformed_response', 'summary.vectors is invalid')
  for (const field of ['sourceIdentities', 'vectorIdentities'] as const) {
    const identities = value[field]
    if (identities === undefined) continue
    if (!isRecord(identities) || Object.keys(identities).length > USER_DATA_LIMITS.maxFileEntries) {
      throw new UserDataProtocolError('malformed_response', `summary.vectors.${field} is invalid`)
    }
    for (const [key, digest] of Object.entries(identities)) {
      if (!key || byteLength(key) > 512 || typeof digest !== 'string' || digest.length > 128) {
        throw new UserDataProtocolError('malformed_response', `summary.vectors.${field} is invalid`)
      }
    }
  }
  const status = value.status
  const normalizedStatus: UserDataVectorSummary['status'] =
    status === 'included' || status === 'rebuild_required' || status === 'skipped' || status === 'unknown'
      ? status
      : value.rebuildRequired === true
        ? 'rebuild_required'
        : 'included'
  return {
    status: normalizedStatus,
    imported: boundedInteger(value.imported ?? value.restored ?? 0, 'summary.vectors.imported'),
    skipped: boundedInteger(value.skipped ?? 0, 'summary.vectors.skipped'),
  }
}

/** Normalize live counters and a committed receipt into one bounded public shape. */
export function normalizeUserDataSummary(rawSummary: unknown, rawFileSummary?: unknown): UserDataReceiptSummary {
  if (!isRecord(rawSummary)) throw new UserDataProtocolError('malformed_response', 'summary is invalid')
  const result = emptySummary()
  const isReceipt = Object.hasOwn(rawSummary, 'tables') || Object.hasOwn(rawSummary, 'files')
  const tableSource = isReceipt ? rawSummary.tables : rawSummary
  if (!isRecord(tableSource)) throw new UserDataProtocolError('malformed_response', 'summary.tables is invalid')
  const tableEntries = Object.entries(tableSource)
  if (tableEntries.length > USER_DATA_LIMITS.maxSummaryEntries) {
    throw new UserDataProtocolError('malformed_response', 'summary is too large')
  }
  for (const [key, value] of tableEntries) {
    if (key === 'vectors' || key === 'secrets') continue
    result.tables[boundedString(key, 'summary key', 512)] = parseSummaryCounts(value, `summary.${key}`)
  }
  const secrets = rawSummary.secrets
  if (secrets !== undefined && secrets !== null) result.secrets = parseSummaryCounts(secrets, 'summary.secrets')
  const filesSource = rawFileSummary ?? (isReceipt ? rawSummary.files : undefined)
  if (filesSource !== undefined && filesSource !== null) {
    result.files = boundedMap(filesSource, 'summary.files', USER_DATA_LIMITS.maxFileEntries)
  }
  result.vectors = normalizeVector(rawSummary.vectors)
  return result
}

function normalizeFailureCode(value: unknown): UserDataFailureCode {
  if (typeof value !== 'string') return 'unknown'
  return KNOWN_FAILURE_CODES.has(value) ? value as UserDataFailureCode : 'unknown'
}

export function normalizeUserDataFailure(value: unknown, fallback: UserDataFailureCode = 'unknown'): UserDataFailure | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') {
    const normalized = normalizeFailureCode(value)
    return { code: normalized === 'unknown' ? fallback : normalized, message: null }
  }
  if (!isRecord(value)) throw new UserDataProtocolError('malformed_response', 'error is invalid')
  const code = normalizeFailureCode(value.code)
  const message = typeof value.message === 'string' && byteLength(value.message) <= USER_DATA_LIMITS.maxFailureMessageBytes
    ? value.message
    : null
  return { code: code === 'unknown' ? fallback : code, message }
}

export function normalizeUserDataApiFailure(error: unknown, fallback: UserDataFailureCode = 'network'): UserDataFailure {
  if (error instanceof UserDataProtocolError) {
    return { code: error.code, message: byteLength(error.message) <= USER_DATA_LIMITS.maxFailureMessageBytes ? error.message : null }
  }
  const errorRecord = isRecord(error) ? error : null
  const body = errorRecord && isRecord(errorRecord.body) ? errorRecord.body : errorRecord
  const code = body?.code ?? body?.status ?? body?.errorCode
  const normalized = normalizeFailureCode(code)
  const rawMessage = body?.message ?? body?.error ?? (error instanceof Error ? error.message : null)
  return {
    code: normalized === 'unknown' ? fallback : normalized,
    message: typeof rawMessage === 'string' && byteLength(rawMessage) <= USER_DATA_LIMITS.maxFailureMessageBytes
      ? rawMessage
      : null,
  }
}


function parseUserDataRuntimeRevision(value: unknown, field: string, nullable = true): number | string | null {
  if (value === null && nullable) return null
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= USER_DATA_LIMITS.maxCounter) return value
  if (typeof value === 'string' && value.length > 0 && byteLength(value) <= USER_DATA_LIMITS.maxStringBytes) return value
  throw new UserDataProtocolError('malformed_response', `${field} is invalid`)
}
function parseUserDataRuntimeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new UserDataProtocolError('malformed_response', `${field} is invalid`)
  return value
}


export function normalizeUserDataRuntimePolicy(value: unknown): UserDataRuntimePolicyV1 | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw new UserDataProtocolError('malformed_response', 'manifest.runtimePolicy is invalid')
  const requiredKeys = ['version', 'authoredValue', 'effectiveValue', 'source', 'scope', 'cap', 'availability', 'presetRevision', 'transientSelection', 'durableChatOverride', 'repairAcknowledgement', 'nextTurnOnly']
  if (Object.keys(value).some((key) => !requiredKeys.includes(key)) || requiredKeys.some((key) => !Object.hasOwn(value, key))) {
    throw new UserDataProtocolError('malformed_response', 'manifest.runtimePolicy contains unknown or missing fields')
  }
  if (value.version !== USER_DATA_RUNTIME_POLICY_VERSION || value.nextTurnOnly !== true) {
    throw new UserDataProtocolError('malformed_response', 'manifest.runtimePolicy version is invalid')
  }
  const modes = ['response', 'agentic'] as const
  const parseMode = (mode: unknown, field: string): 'response' | 'agentic' => {
    if (mode !== 'response' && mode !== 'agentic') throw new UserDataProtocolError('malformed_response', `${field} is invalid`)
    return mode
  }
  const source = value.source
  if (!(USER_DATA_RUNTIME_POLICY_SOURCES as readonly string[]).includes(String(source))) {
    throw new UserDataProtocolError('malformed_response', 'manifest.runtimePolicy.source is invalid')
  }
  const scope = value.scope
  if (!(USER_DATA_RUNTIME_POLICY_SCOPES as readonly string[]).includes(String(scope))) {
    throw new UserDataProtocolError('malformed_response', 'manifest.runtimePolicy.scope is invalid')
  }
  if (!isRecord(value.cap) || Object.keys(value.cap).some((key) => !['authority', 'allowedModes', 'reasonCode'].includes(key)) || Object.keys(value.cap).length !== 3 || value.cap.authority !== 'host' || !Array.isArray(value.cap.allowedModes) || value.cap.allowedModes.length > 2 || value.cap.allowedModes.some((mode) => !modes.includes(mode as typeof modes[number]))) {
    throw new UserDataProtocolError('malformed_response', 'manifest.runtimePolicy.cap is invalid')
  }
  const cap = value.cap as Record<string, unknown>
  const allowedModes = (cap.allowedModes as unknown[]).map((mode) => parseMode(mode, 'manifest.runtimePolicy.cap.allowedModes'))
  if (new Set(allowedModes).size !== allowedModes.length) throw new UserDataProtocolError('malformed_response', 'manifest.runtimePolicy.cap.allowedModes is invalid')
  const parseReason = (reason: unknown, field: string): string | null => reason === null ? null : optionalString(reason, field)
  if (!isRecord(value.availability) || Object.keys(value.availability).some((key) => !['state', 'reasonCode'].includes(key)) || Object.keys(value.availability).length !== 2 || !(USER_DATA_RUNTIME_POLICY_AVAILABILITY as readonly string[]).includes(String(value.availability.state))) {
    throw new UserDataProtocolError('malformed_response', 'manifest.runtimePolicy.availability is invalid')
  }
  const availability = value.availability as Record<string, unknown>
  const transientSelection = value.transientSelection === null ? null : value.transientSelection as Record<string, unknown>
  if (transientSelection !== null) {
    if (!isRecord(transientSelection) || Object.keys(transientSelection).some((key) => !['mode', 'turnFence', 'authenticated'].includes(key)) || Object.keys(transientSelection).length !== 3 || transientSelection.authenticated !== true) {
      throw new UserDataProtocolError('malformed_response', 'manifest.runtimePolicy.transientSelection is invalid')
    }
  }
  const durableChatOverrideValue = value.durableChatOverride
  let durableChatOverride: Record<string, unknown> | null
  if (durableChatOverrideValue === null) {
    durableChatOverride = null
  } else if (!isRecord(durableChatOverrideValue)) {
    throw new UserDataProtocolError('malformed_response', 'manifest.runtimePolicy.durableChatOverride is invalid')
  } else {
    durableChatOverride = durableChatOverrideValue
  }
  if (durableChatOverride !== null) {
    if (Object.keys(durableChatOverride).some((key) => !['mode', 'revision', 'state', 'reviewCode', 'acknowledged'].includes(key)) || Object.keys(durableChatOverride).length !== 5 || !['ready', 'review_required', 'repair_required'].includes(String(durableChatOverride.state)) || typeof durableChatOverride.revision !== 'number' || !Number.isSafeInteger(durableChatOverride.revision) || durableChatOverride.revision < 0 || typeof durableChatOverride.acknowledged !== 'boolean') {
      throw new UserDataProtocolError('malformed_response', 'manifest.runtimePolicy.durableChatOverride is invalid')
    }
  }
  const repairAcknowledgement = value.repairAcknowledgement as Record<string, unknown>
  if (!isRecord(repairAcknowledgement) || Object.keys(repairAcknowledgement).some((key) => !['state', 'presetRevision', 'reasonCode', 'acknowledgedAt'].includes(key)) || Object.keys(repairAcknowledgement).length !== 4 || !['not_required', 'required', 'acknowledged'].includes(String(repairAcknowledgement.state))) {
    throw new UserDataProtocolError('malformed_response', 'manifest.runtimePolicy.repairAcknowledgement is invalid')
  }
  return {
    version: USER_DATA_RUNTIME_POLICY_VERSION,
    authoredValue: parseMode(value.authoredValue, 'manifest.runtimePolicy.authoredValue'),
    effectiveValue: parseMode(value.effectiveValue, 'manifest.runtimePolicy.effectiveValue'),
    source: source as UserDataRuntimePolicySource,
    scope: scope as UserDataRuntimePolicyScope,
    cap: {
      authority: 'host',
      allowedModes,
      reasonCode: parseReason(cap.reasonCode, 'manifest.runtimePolicy.cap.reasonCode'),
    },
    availability: {
      state: availability.state as UserDataRuntimePolicyAvailability,
      reasonCode: parseReason(availability.reasonCode, 'manifest.runtimePolicy.availability.reasonCode'),
    },
    presetRevision: parseUserDataRuntimeRevision(value.presetRevision, 'manifest.runtimePolicy.presetRevision'),
    transientSelection: transientSelection === null ? null : {
      mode: parseMode(transientSelection.mode, 'manifest.runtimePolicy.transientSelection.mode'),
      turnFence: parseUserDataRuntimeRevision(transientSelection.turnFence, 'manifest.runtimePolicy.transientSelection.turnFence', false) as number | string,
      authenticated: true,
    },
    durableChatOverride: durableChatOverride === null ? null : {
      mode: durableChatOverride.mode === null ? null : parseMode(durableChatOverride.mode, 'manifest.runtimePolicy.durableChatOverride.mode'),
      revision: boundedInteger(durableChatOverride.revision, 'manifest.runtimePolicy.durableChatOverride.revision'),
      state: durableChatOverride.state as 'ready' | 'review_required' | 'repair_required',
      reviewCode: parseReason(durableChatOverride.reviewCode, 'manifest.runtimePolicy.durableChatOverride.reviewCode'),
      acknowledged: parseUserDataRuntimeBoolean(durableChatOverride.acknowledged, 'manifest.runtimePolicy.durableChatOverride.acknowledged'),
    },
    repairAcknowledgement: {
      state: repairAcknowledgement.state as 'not_required' | 'required' | 'acknowledged',
      presetRevision: parseUserDataRuntimeRevision(repairAcknowledgement.presetRevision, 'manifest.runtimePolicy.repairAcknowledgement.presetRevision'),
      reasonCode: parseReason(repairAcknowledgement.reasonCode, 'manifest.runtimePolicy.repairAcknowledgement.reasonCode'),
      acknowledgedAt: repairAcknowledgement.acknowledgedAt === null ? null : optionalTimestamp(repairAcknowledgement.acknowledgedAt, 'manifest.runtimePolicy.repairAcknowledgement.acknowledgedAt'),
    },
    nextTurnOnly: true,
  }
}

function parseManifest(value: unknown): UserDataManifest | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw new UserDataProtocolError('malformed_response', 'manifest is invalid')
  const embedding = value.embeddingConfig
  if (!isRecord(embedding)) throw new UserDataProtocolError('malformed_response', 'manifest.embeddingConfig is invalid')
  const dimension = embedding.dimension === null || embedding.dimension === undefined
    ? null
    : boundedInteger(embedding.dimension, 'manifest.embeddingConfig.dimension', 10_000_000)
  const entries = value.entries
  if (entries !== undefined && (!Array.isArray(entries) || entries.length > USER_DATA_LIMITS.maxManifestEntries)) {
    throw new UserDataProtocolError('malformed_response', 'manifest.entries is too large')
  }
  const counts = boundedMap(value.counts, 'manifest.counts', USER_DATA_LIMITS.maxManifestCounts)
  const missingFiles = boundedStringList(value.missingFiles ?? [], 'manifest.missingFiles', USER_DATA_LIMITS.maxManifestMissingFiles)
  return {
    schemaVersion: boundedInteger(value.schemaVersion, 'manifest.schemaVersion', 100),
    exportedAt: optionalTimestamp(value.exportedAt, 'manifest.exportedAt') ?? 0,
    archiveId: boundedString(value.archiveId, 'manifest.archiveId', USER_DATA_LIMITS.maxJobIdBytes),
    producerVersion: optionalString(value.producerVersion, 'manifest.producerVersion'),
    includeVectors: value.includeVectors === true,
    embeddingConfig: {
      provider: optionalString(embedding.provider, 'manifest.embeddingConfig.provider'),
      model: optionalString(embedding.model, 'manifest.embeddingConfig.model'),
      dimension,
    },
    counts,
    missingFiles,
    hasEncryptedSecrets: value.hasEncryptedSecrets === true,
    secretsCount: value.secretsCount === undefined ? 0 : boundedInteger(value.secretsCount, 'manifest.secretsCount', 100_000),
    registryVersion: value.registryVersion === undefined ? null : boundedInteger(value.registryVersion, 'manifest.registryVersion', 100_000),
    snapshotId: optionalString(value.snapshotId, 'manifest.snapshotId', USER_DATA_LIMITS.maxJobIdBytes),
    entryCount: Array.isArray(entries) ? entries.length : null,
    runtimePolicy: Object.hasOwn(value, 'runtimePolicy') ? normalizeUserDataRuntimePolicy(value.runtimePolicy) : null,
  }
}

export function normalizeUserDataProgress(value: unknown): UserDataProgress {
  if (!isRecord(value)) throw new UserDataProtocolError('malformed_response', 'progress is invalid')
  const processed = value.processed === undefined || value.processed === null
    ? null
    : boundedInteger(value.processed, 'progress.processed')
  const total = value.total === undefined || value.total === null
    ? null
    : boundedInteger(value.total, 'progress.total')
  if (processed !== null && total !== null && processed > total) {
    throw new UserDataProtocolError('malformed_response', 'progress range is invalid')
  }
  return {
    phase: boundedString(value.phase, 'progress.phase', 256),
    table: optionalString(value.table, 'progress.table', 512),
    processed,
    total,
  }
}

function parseProgress(value: unknown): UserDataProgress | null {
  if (value === null || value === undefined) return null
  return normalizeUserDataProgress(value)
}

function parseStatus(value: unknown): UserDataJobStatus {
  if (value === 'committed') return 'complete'
  if (value === 'validating' || value === 'queued' || value === 'awaiting_ticket' || value === 'running' || value === 'installing' || value === 'ready' || value === 'committing' || value === 'cancelling' || value === 'cleanup_pending' || value === 'complete' || value === 'failed' || value === 'cancelled') return value
  throw new UserDataProtocolError('malformed_response', 'job status is invalid')
}

/** Parse one server job response; all nested maps are bounded here and nowhere else. */
export function normalizeUserDataJob(value: unknown): UserDataJob {
  if (!isRecord(value)) throw new UserDataProtocolError('malformed_response', 'job is invalid')
  const jobId = boundedString(value.jobId ?? value.job_id, 'jobId', USER_DATA_LIMITS.maxJobIdBytes)
  const status = parseStatus(value.status ?? value.state)
  const manifest = parseManifest(value.manifest)
  const summary = normalizeUserDataSummary(value.summary ?? {}, value.fileSummary ?? value.file_summary)
  const failure = normalizeUserDataFailure(value.error ?? value.failure, status === 'cancelled' ? 'cancelled' : 'unknown')
  const ticketValue = isRecord(value.ticket) ? value.ticket : null
  const secretsCount = ticketValue?.secretsCount ?? manifest?.secretsCount ?? 0
  const parsedSecretsCount = boundedInteger(secretsCount, 'ticket.secretsCount', 100_000)
  return {
    jobId,
    archiveId: optionalString(value.archiveId ?? value.archive_id ?? manifest?.archiveId, 'archiveId', USER_DATA_LIMITS.maxJobIdBytes),
    status,
    startedAt: optionalTimestamp(value.startedAt ?? value.started_at, 'startedAt'),
    finishedAt: optionalTimestamp(value.finishedAt ?? value.finished_at, 'finishedAt'),
    updatedAt: optionalTimestamp(value.updatedAt ?? value.updated_at, 'updatedAt'),
    manifest,
    progress: parseProgress(value.progress),
    summary,
    failure,
    ticket: {
      required: status === 'awaiting_ticket' || ticketValue?.required === true,
      secretsCount: parsedSecretsCount,
    },
  }
}

export function normalizeUserDataStartImport(value: unknown): UserDataStartImportResponse {
  if (!isRecord(value)) throw new UserDataProtocolError('malformed_response', 'import start response is invalid')
  return {
    jobId: boundedString(value.jobId ?? value.job_id, 'jobId', USER_DATA_LIMITS.maxJobIdBytes),
    status: parseStatus(value.status ?? 'queued'),
  }
}

/** Validate a route identifier before interpolation into an authenticated API path. */
export function normalizeUserDataJobId(value: unknown): string {
  return boundedString(value, 'jobId', USER_DATA_LIMITS.maxJobIdBytes)
}

export function normalizeUserDataExportPrepare(value: unknown): UserDataExportPrepareResponse {
  if (!isRecord(value)) throw new UserDataProtocolError('malformed_response', 'export prepare response is invalid')
  const ticket = value.ticket === null || value.ticket === undefined ? null : parseDecryptionTicket(value.ticket)
  return {
    archiveId: boundedString(value.archiveId, 'archiveId', USER_DATA_LIMITS.maxJobIdBytes),
    archiveUrl: boundedString(value.archiveUrl, 'archiveUrl', 2_048),
    archiveFilename: boundedString(value.archiveFilename, 'archiveFilename', 512),
    ticketFilename: optionalString(value.ticketFilename, 'ticketFilename', 512),
    ticket,
    secretsCount: boundedInteger(value.secretsCount ?? 0, 'secretsCount', 100_000),
    unreachableSecrets: boundedStringList(value.unreachableSecrets ?? [], 'unreachableSecrets', USER_DATA_LIMITS.maxManifestMissingFiles),
  }
}


export function normalizeUserDataCommand(value: unknown): UserDataCommandResponse {
  if (!isRecord(value)) throw new UserDataProtocolError('malformed_response', 'command response is invalid')
  const statusValue = value.status
  const status = statusValue === null || statusValue === undefined
    ? null
    : statusValue === 'too_late' || statusValue === 'not_found'
      ? statusValue
      : parseStatus(statusValue)
  const job = value.job === undefined || value.job === null ? null : normalizeUserDataJob(value.job)
  return {
    accepted: value.accepted === true || value.skipped === true || status === 'cancelled' || status === 'cancelling' || status === 'cleanup_pending',
    status,
    job,
    failure: normalizeUserDataFailure(value.error ?? value.failure, status === 'too_late' ? 'too_late' : 'unknown'),
  }
}

export function parseDecryptionTicket(input: unknown): DecryptionTicket {
  let value: unknown = input
  if (typeof input === 'string') {
    if (byteLength(input) > USER_DATA_LIMITS.maxTicketBytes) {
      throw new UserDataProtocolError('ticket_invalid', 'ticket file is too large')
    }
    try {
      value = JSON.parse(input) as unknown
    } catch {
      throw new UserDataProtocolError('ticket_invalid', 'ticket file is not valid JSON')
    }
  }
  if (!isRecord(value)) throw new UserDataProtocolError('ticket_invalid', 'ticket is invalid')
  if (value.kind !== 'lumiverse-decryption-ticket' || value.version !== 1 || value.issuer !== 'lumiverse' || value.algorithm !== 'AES-256-GCM') {
    throw new UserDataProtocolError('ticket_invalid', 'ticket is invalid')
  }
  const keyB64 = boundedString(value.keyB64, 'ticket.keyB64', 128 * 1024)
  const secretsHash = boundedString(value.secretsHash, 'ticket.secretsHash', 128)
  if (!/^[0-9a-fA-F]{64}$/.test(secretsHash)) throw new UserDataProtocolError('ticket_invalid', 'ticket hash is invalid')
  const issuedAt = optionalTimestamp(value.issuedAt, 'ticket.issuedAt')
  if (issuedAt === null) throw new UserDataProtocolError('ticket_invalid', 'ticket issuedAt is invalid')
  return {
    kind: 'lumiverse-decryption-ticket',
    version: 1,
    archiveId: boundedString(value.archiveId, 'ticket.archiveId', USER_DATA_LIMITS.maxJobIdBytes),
    issuer: 'lumiverse',
    issuerInstance: optionalString(value.issuerInstance, 'ticket.issuerInstance', 512),
    issuedAt,
    algorithm: 'AES-256-GCM',
    keyB64,
    secretsHash,
  }
}
export function isUserDataJobActive(status: UserDataJobStatus): boolean {
  return status === 'queued' || status === 'validating' || status === 'awaiting_ticket' || status === 'running' || status === 'installing' || status === 'ready' || status === 'committing' || status === 'cancelling' || status === 'cleanup_pending'
}

export function isUserDataJobCancellable(status: UserDataJobStatus): boolean {
  return status === 'queued' || status === 'validating' || status === 'awaiting_ticket' || status === 'running' || status === 'installing' || status === 'ready'
}
