import { presetsApi } from '@/api/presets'
import type { Preset, UpdatePresetInput } from '@/types/api'
import { looksLikeLoomPresetData, marshalUpdate, unmarshalPreset } from './service'
import type { LoomPreset } from './types'

const PENDING_LOOM_PRESETS_KEY = '__lumiverse_pending_loom_presets'
const PENDING_LOOM_PRESET_ENVELOPE_KEY = '__lumiverse_pending_loom_preset_v2'
const MAX_REVISION_CONFLICT_RETRIES = 3

const DRAFT_FIELDS = [
  'name',
  'description',
  'coverUrl',
  'presetVersion',
  'lumihubMeta',
  'schemaVersion',
  'blocks',
  'source',
  'isDefault',
  'samplerOverrides',
  'customBody',
  'promptBehavior',
  'completionSettings',
  'advancedSettings',
  'modelProfiles',
  'lastProfileKey',
  'promptVariables',
] as const satisfies readonly (keyof LoomPreset)[]

type DraftField = (typeof DRAFT_FIELDS)[number]

interface DirtyPresetPaths {
  fields: DraftField[]
  passthroughKeys: string[]
}

interface PendingLoomPresetEnvelope {
  [PENDING_LOOM_PRESET_ENVELOPE_KEY]: 2
  preset: LoomPreset
  dirty: DirtyPresetPaths
  revision: number
}

interface PresetSaveEntry {
  confirmed: LoomPreset
  draft: LoomPreset
  dirty: DirtyPresetPaths
  revision: number
  timer: ReturnType<typeof globalThis.setTimeout> | null
  chain: Promise<LoomPreset>
  queuedRevision: number | null
  queuedSnapshot: LoomPreset | null
  queuedSnapshots: LoomPreset[]
  listeners: Set<(preset: LoomPreset) => void>
}

export interface PresetSaveAdapter {
  update(presetId: string, input: UpdatePresetInput): Promise<Preset>
  /** Read the latest persisted row when a conditional update detects a conflict. */
  get?: (presetId: string) => Promise<Preset>
}

export interface PresetMutationOptions {
  immediate?: boolean
  debounceMs?: number
}

export interface PresetHydrationToken {
  readonly presetId: string
  readonly owner: string
  readonly readEpoch: number
  readonly globalReadEpoch: number
  readonly confirmedEpoch: number
  readonly scopeEpoch: number
}

export class StalePresetHydrationError extends Error {
  constructor(presetId: string) {
    super(`Stale preset hydration: ${presetId}`)
    this.name = 'StalePresetHydrationError'
  }
}
export class PresetScopeChangedError extends Error {
  constructor() {
    super('Preset save scope changed during generation flush')
    this.name = 'PresetScopeChangedError'
  }
}
export class PresetBlockConflictError extends Error {
  constructor(presetId: string) {
    super(`Preset block changes conflict with a newer persisted revision: ${presetId}`)
    this.name = 'PresetBlockConflictError'
  }
}

export interface PresetSaveCoordinator {
  /** Replace the authenticated-user scope and discard in-memory work from the previous scope. */
  setScope(scope: string | null): void
  /** Identify the current scope for guarding in-flight recovery work. */
  getScopeEpoch(): number
  /**
   * Reserve this consumer's next persisted-row read. A later read by the same
   * consumer supersedes it; another consumer cannot strand this reader if its
   * own request fails.
   */
  beginHydration(presetId: string, owner?: string): PresetHydrationToken
  /** Release a hydration token whose persisted-row request did not resolve. */
  cancelHydration(token: PresetHydrationToken): void
  /**
   * Incorporate a freshly read persisted row. Any durable or in-memory dirty
   * paths are rebased over that row; untouched paths always come from the row.
   */
  hydrate(preset: LoomPreset, token?: PresetHydrationToken): LoomPreset
  /** Return the current per-preset draft, if this coordinator owns one. */
  getDraft(presetId: string): LoomPreset | null
  /** True when the preset has unsaved local changes. */
  hasPendingChanges(presetId: string): boolean
  /** True when only durable recovery state exists and a persisted read is required before flushing. */
  hasDurablePendingRecovery(presetId: string): boolean
  /**
   * Atomically derive a draft from the coordinator's current value. A fallback
   * is used only on the first writer for a preset, preventing a stale caller
   * snapshot from replacing an already-known newer draft.
   */
  mutate(
    presetId: string,
    fallback: LoomPreset,
    mutator: (current: LoomPreset) => LoomPreset,
    options?: PresetMutationOptions,
  ): LoomPreset
  /** Await all pending work and persist the current draft when it is dirty. */
  flush(presetId: string): Promise<LoomPreset | null>
  /** Queue a best-effort save without waiting; retained recovery handles exit failures. */
  flushBestEffort(presetId: string): void
  /** Subscribe to draft, rebase, and persistence transitions for one preset. */
  subscribe(presetId: string, listener: (preset: LoomPreset) => void): () => void
  /** Forget all in-memory and durable state after a confirmed deletion. */
  remove(presetId: string): void
}

function clone<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function isRevisionConflict(error: unknown): boolean {
  if (!isRecord(error) || error.status !== 409 || !isRecord(error.body)) return false
  return error.body.code === 'PRESET_REVISION_CONFLICT'
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (
    typeof left !== 'object'
    || left === null
    || typeof right !== 'object'
    || right === null
  ) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameJson(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
}

function canonicalPersistedPayload(preset: LoomPreset): unknown {
  const { expected_cache_revision: _expectedCacheRevision, ...payload } = marshalUpdate(preset)
  return payload
}

function isDraftField(value: unknown): value is DraftField {
  return typeof value === 'string' && (DRAFT_FIELDS as readonly string[]).includes(value)
}

function normalizeDirtyPaths(value: unknown): DirtyPresetPaths | null {
  if (!isRecord(value) || !Array.isArray(value.fields) || !Array.isArray(value.passthroughKeys)) return null
  if (
    !value.fields.every(isDraftField)
    || !value.passthroughKeys.every((key) => typeof key === 'string')
  ) return null
  return {
    fields: [...new Set(value.fields)],
    passthroughKeys: [...new Set(value.passthroughKeys)],
  }
}

function isDirty(dirty: DirtyPresetPaths): boolean {
  return dirty.fields.length > 0 || dirty.passthroughKeys.length > 0
}

function emptyDirtyPaths(): DirtyPresetPaths {
  return { fields: [], passthroughKeys: [] }
}

function mergeDirtyPaths(previous: DirtyPresetPaths, next: DirtyPresetPaths): DirtyPresetPaths {
  return {
    fields: [...new Set([...previous.fields, ...next.fields])],
    passthroughKeys: [...new Set([...previous.passthroughKeys, ...next.passthroughKeys])],
  }
}

function getChangedPaths(before: LoomPreset, after: LoomPreset): DirtyPresetPaths {
  const fields = DRAFT_FIELDS.filter((field) => !sameJson(before[field], after[field]))
  const beforeMetadata = before.passthroughMetadata ?? {}
  const afterMetadata = after.passthroughMetadata ?? {}
  const passthroughKeys = [...new Set([
    ...Object.keys(beforeMetadata),
    ...Object.keys(afterMetadata),
  ])].filter((key) => !sameJson(beforeMetadata[key], afterMetadata[key]))

  return { fields, passthroughKeys }
}
function preserveResponseState(
  saved: LoomPreset,
  source: LoomPreset,
  response: Preset,
): LoomPreset {
  const responseMetadata = isRecord(response.metadata) ? response.metadata : {}
  const responseParameters = isRecord(response.parameters) ? response.parameters : {}
  const responsePrompts = isRecord(response.prompts) ? response.prompts : {}
  const preserved = clone(saved)

  if (!Object.hasOwn(response, 'name')) preserved.name = source.name
  if (!Object.hasOwn(response, 'created_at')) preserved.createdAt = source.createdAt
  if (!Object.hasOwn(response, 'updated_at')) preserved.updatedAt = source.updatedAt
  if (!Object.hasOwn(response, 'prompt_order')) preserved.blocks = clone(source.blocks)
  if (!Object.hasOwn(response, 'cache_revision') && typeof source.cacheRevision === 'number') {
    preserved.cacheRevision = source.cacheRevision
  } else if (typeof response.cache_revision !== 'number' && typeof source.cacheRevision === 'number') {
    preserved.cacheRevision = source.cacheRevision
  }

  if (!Object.hasOwn(responseParameters, 'samplerOverrides')) {
    preserved.samplerOverrides = clone(source.samplerOverrides)
  }
  if (!Object.hasOwn(responseParameters, 'customBody')) {
    preserved.customBody = clone(source.customBody)
  }
  if (!Object.hasOwn(responsePrompts, 'promptBehavior')) {
    preserved.promptBehavior = clone(source.promptBehavior)
  }
  if (!Object.hasOwn(responsePrompts, 'completionSettings')) {
    preserved.completionSettings = clone(source.completionSettings)
  }
  if (!Object.hasOwn(responsePrompts, 'advancedSettings')) {
    preserved.advancedSettings = clone(source.advancedSettings)
  }

  if (!Object.hasOwn(responseMetadata, 'source')) preserved.source = clone(source.source)
  if (!Object.hasOwn(responseMetadata, 'modelProfiles')) {
    preserved.modelProfiles = clone(source.modelProfiles)
  }
  if (!Object.hasOwn(responseMetadata, 'schemaVersion')) {
    preserved.schemaVersion = source.schemaVersion
  }
  if (!Object.hasOwn(responseMetadata, 'description')) {
    preserved.description = source.description
  }
  if (!Object.hasOwn(responseMetadata, 'coverUrl') && !Object.hasOwn(responseMetadata, 'cover_url')) {
    preserved.coverUrl = source.coverUrl
  }
  if (!Object.hasOwn(responseMetadata, 'isDefault')) {
    preserved.isDefault = source.isDefault
  }
  if (!Object.hasOwn(responseMetadata, 'lastProfileKey')) {
    preserved.lastProfileKey = source.lastProfileKey
  }
  if (!Object.hasOwn(responseMetadata, 'promptVariables')) {
    preserved.promptVariables = clone(source.promptVariables)
  }
  if (!Object.hasOwn(responseMetadata, '_lumiverse_preset_version')) {
    preserved.presetVersion = source.presetVersion
  }

  const savedMetadata = saved.passthroughMetadata ?? {}
  const sourceMetadata = source.passthroughMetadata ?? {}
  const missingPassthroughKeys = Object.keys(sourceMetadata).filter((key) => (
    !Object.hasOwn(responseMetadata, key)
  ))
  if (missingPassthroughKeys.length > 0) {
    preserved.passthroughMetadata = {
      ...clone(sourceMetadata),
      ...clone(savedMetadata),
    }
  }

  const savedLumihubMeta = saved.lumihubMeta ?? {}
  const sourceLumihubMeta = source.lumihubMeta ?? {}
  const missingLumihubKeys = Object.keys(sourceLumihubMeta).filter((key) => (
    !Object.hasOwn(responseMetadata, key)
  ))
  if (missingLumihubKeys.length > 0) {
    preserved.lumihubMeta = {
      ...clone(sourceLumihubMeta),
      ...clone(savedLumihubMeta),
    }
  }
  return preserved
}

function rebaseDirtyPaths(
  persisted: LoomPreset,
  draft: LoomPreset,
  dirty: DirtyPresetPaths,
): LoomPreset {
  const rebased = clone(persisted)

  for (const field of dirty.fields) {
    rebased[field] = clone(draft[field]) as never
  }

  if (dirty.passthroughKeys.length > 0) {
    const metadata = clone(persisted.passthroughMetadata ?? {})
    for (const key of dirty.passthroughKeys) {
      if (Object.hasOwn(draft.passthroughMetadata, key)) {
        Object.defineProperty(metadata, key, {
          value: clone(draft.passthroughMetadata[key]),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      } else {
        delete metadata[key]
      }
    }
    rebased.passthroughMetadata = metadata
  }

  return rebased
}
function confirmPersistedDirtyPaths(
  persisted: LoomPreset,
  draft: LoomPreset,
  dirty: DirtyPresetPaths,
): { draft: LoomPreset; dirty: DirtyPresetPaths } {
  const fields = dirty.fields.filter((field) => !sameJson(persisted[field], draft[field]))
  const persistedMetadata = persisted.passthroughMetadata ?? {}
  const draftMetadata = draft.passthroughMetadata ?? {}
  const passthroughKeys = dirty.passthroughKeys.filter((key) => (
    !sameJson(persistedMetadata[key], draftMetadata[key])
  ))
  const remaining = { fields, passthroughKeys }
  return {
    draft: rebaseDirtyPaths(persisted, draft, remaining),
    dirty: remaining,
  }
}

function pendingStorageKey(scope: string | null): string {
  return scope ? `${PENDING_LOOM_PRESETS_KEY}:${scope}` : PENDING_LOOM_PRESETS_KEY
}

function readPendingEntries(scope: string | null): Record<string, unknown> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = globalThis.localStorage.getItem(pendingStorageKey(scope))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writePendingEntries(scope: string | null, entries: Record<string, unknown>): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (Object.keys(entries).length === 0) {
      globalThis.localStorage.removeItem(pendingStorageKey(scope))
      return true
    }
    globalThis.localStorage.setItem(pendingStorageKey(scope), JSON.stringify(entries))
    return true
  } catch {
    // Recovery is best-effort; the in-memory coordinator still serializes work.
    return false
  }
}


function legacyDirtyPaths(includePromptVariables: boolean): DirtyPresetPaths {
  const fields: DraftField[] = DRAFT_FIELDS.filter((field) => (
    field !== 'promptVariables'
    && field !== 'lumihubMeta'
    && field !== 'presetVersion'
  ))
  if (includePromptVariables) fields.push('promptVariables')
  return { fields, passthroughKeys: [] }
}
function readPendingEnvelope(presetId: string, scope: string | null): PendingLoomPresetEnvelope | null {
  const entry = readPendingEntries(scope)[presetId]
  if (!isRecord(entry)) return null

  if (entry[PENDING_LOOM_PRESET_ENVELOPE_KEY] === 2) {
    if (!looksLikeLoomPresetData(entry.preset) || entry.preset.id !== presetId) return null
    const dirty = normalizeDirtyPaths(entry.dirty)
    if (!dirty || !isDirty(dirty) || typeof entry.revision !== 'number' || !Number.isSafeInteger(entry.revision)) {
      return null
    }
    return {
      [PENDING_LOOM_PRESET_ENVELOPE_KEY]: 2,
      preset: entry.preset,
      dirty,
      revision: entry.revision,
    }
  }

  // v1 envelopes tracked prompt ownership but did not track individual fields.
  // Retain their editor intent while inheriting fresh extension/LumiHub metadata.
  if (entry.__lumiverse_pending_loom_preset_v1 === 1) {
    if (!looksLikeLoomPresetData(entry.preset) || entry.preset.id !== presetId) return null
    const includeEditorContent = entry.includeEditorContent !== false
    const includePromptVariables = entry.includePromptVariables === true
    return {
      [PENDING_LOOM_PRESET_ENVELOPE_KEY]: 2,
      preset: entry.preset,
      dirty: includeEditorContent
        ? legacyDirtyPaths(includePromptVariables)
        : { fields: includePromptVariables ? ['promptVariables'] : [], passthroughKeys: [] },
      revision: typeof entry.revision === 'number' && Number.isSafeInteger(entry.revision)
        ? entry.revision
        : 0,
    }
  }

  // The original Loom editor stored a raw full snapshot. It cannot identify a
  // prompt-variable or extension owner, so recovery deliberately replays only
  // ordinary editor fields over the fresh persisted row.
  if (!looksLikeLoomPresetData(entry) || entry.id !== presetId) return null
  return {
    [PENDING_LOOM_PRESET_ENVELOPE_KEY]: 2,
    preset: entry,
    dirty: legacyDirtyPaths(false),
    revision: 0,
  }
}
function migrateLegacyPendingEnvelope(presetId: string, scope: string | null): void {
  if (!scope || readPendingEnvelope(presetId, scope)) return
  const legacy = readPendingEnvelope(presetId, null)
  if (!legacy) return

  const scopedEntries = readPendingEntries(scope)
  scopedEntries[presetId] = legacy
  if (!writePendingEntries(scope, scopedEntries)) return

  const legacyEntries = readPendingEntries(null)
  if (!(presetId in legacyEntries)) return
  delete legacyEntries[presetId]
  writePendingEntries(null, legacyEntries)
}

function writePendingEnvelope(
  presetId: string,
  entry: PresetSaveEntry,
  scope: string | null,
): void {
  const all = readPendingEntries(scope)
  if (!isDirty(entry.dirty)) {
    delete all[presetId]
    writePendingEntries(scope, all)
    return
  }

  const envelope: PendingLoomPresetEnvelope = {
    [PENDING_LOOM_PRESET_ENVELOPE_KEY]: 2,
    preset: entry.draft,
    dirty: entry.dirty,
    revision: entry.revision,
  }
  all[presetId] = envelope
  writePendingEntries(scope, all)
}

function removePendingEnvelope(presetId: string, scope: string | null): void {
  const all = readPendingEntries(scope)
  if (!(presetId in all)) return
  delete all[presetId]
  writePendingEntries(scope, all)
}

function createEntry(preset: LoomPreset): PresetSaveEntry {
  return {
    confirmed: clone(preset),
    draft: clone(preset),
    dirty: emptyDirtyPaths(),
    revision: 0,
    timer: null,
    chain: Promise.resolve(clone(preset)),
    queuedRevision: null,
    queuedSnapshot: null,
    queuedSnapshots: [],
    listeners: new Set(),
  }
}

/**
 * Create an isolated coordinator. Tests and alternate hosts provide their own
 * adapter; the application-wide coordinator below uses the regular preset API.
 */
export function createPresetSaveCoordinator(adapter: PresetSaveAdapter): PresetSaveCoordinator {
  const entries = new Map<string, PresetSaveEntry>()
  const listenersByPreset = new Map<string, Set<(preset: LoomPreset) => void>>()
  const hydrationReadEpochs = new Map<string, Map<string, number>>()
  const latestHydrationReadEpochs = new Map<string, number>()
  const confirmedEpochs = new Map<string, number>()
  const confirmedCacheRevisions = new Map<string, number>()
  const confirmedSnapshots = new Map<string, LoomPreset>()
  const rememberConfirmedCacheRevision = (presetId: string, preset: LoomPreset): void => {
    if (typeof preset.cacheRevision !== 'number') return
    const previous = confirmedCacheRevisions.get(presetId)
    if (previous === undefined || preset.cacheRevision > previous) {
      confirmedCacheRevisions.set(presetId, preset.cacheRevision)
      confirmedSnapshots.set(presetId, clone(preset))
    }
  }
  const pendingHydrations = new Set<PresetHydrationToken>()
  let scopeEpoch = 0
  let pendingStorageScope: string | null = null

  const discardScopeState = (): void => {
    for (const entry of entries.values()) {
      if (entry.timer !== null) globalThis.clearTimeout(entry.timer)
    }
    entries.clear()
    listenersByPreset.clear()
    hydrationReadEpochs.clear()
    latestHydrationReadEpochs.clear()
    confirmedEpochs.clear()
    confirmedCacheRevisions.clear()
    confirmedSnapshots.clear()
    pendingHydrations.clear()
  }

  const getHydrationReadEpoch = (presetId: string, owner: string): number => (
    hydrationReadEpochs.get(presetId)?.get(owner) ?? 0
  )
  const reserveHydrationRead = (presetId: string, owner: string): {
    readEpoch: number
    globalReadEpoch: number
  } => {
    const owners = hydrationReadEpochs.get(presetId) ?? new Map<string, number>()
    const readEpoch = getHydrationReadEpoch(presetId, owner) + 1
    owners.set(owner, readEpoch)
    hydrationReadEpochs.set(presetId, owners)
    const globalReadEpoch = (latestHydrationReadEpochs.get(presetId) ?? 0) + 1
    latestHydrationReadEpochs.set(presetId, globalReadEpoch)
    return { readEpoch, globalReadEpoch }
  }
  const getConfirmedEpoch = (presetId: string): number => confirmedEpochs.get(presetId) ?? 0
  const advanceConfirmedEpoch = (presetId: string): void => {
    confirmedEpochs.set(presetId, getConfirmedEpoch(presetId) + 1)
  }

  const hasPendingHydration = (presetId: string): boolean => {
    for (const token of pendingHydrations) {
      if (token.presetId === presetId) return true
    }
    return false
  }

  function publish(entry: PresetSaveEntry): void {
    const snapshot = clone(entry.draft)
    for (const listener of entry.listeners) {
      try { listener(clone(snapshot)) } catch { /* one subscriber cannot break saves */ }
    }
  }

  function ensure(presetId: string, fallback: LoomPreset): PresetSaveEntry {
    const existing = entries.get(presetId)
    if (existing) return existing
    if (fallback.id !== presetId) throw new Error('Preset coordinator fallback id mismatch')
    const remembered = confirmedSnapshots.get(presetId)
    const initial = remembered
      && typeof fallback.cacheRevision === 'number'
      && typeof remembered.cacheRevision === 'number'
      && remembered.cacheRevision > fallback.cacheRevision
      ? remembered
      : fallback
    const entry = createEntry(initial)
    rememberConfirmedCacheRevision(presetId, entry.confirmed)
    entry.listeners = listenersByPreset.get(presetId) ?? new Set()
    listenersByPreset.set(presetId, entry.listeners)
    const pending = readPendingEnvelope(presetId, pendingStorageScope)
    if (pending) {
      entry.draft = rebaseDirtyPaths(initial, pending.preset, pending.dirty)
      entry.dirty = pending.dirty
      entry.revision = pending.revision
    }
    entries.set(presetId, entry)
    return entry
  }

  function evictCleanEntry(presetId: string): void {
    const entry = entries.get(presetId)
    if (
      !entry
      || entry.listeners.size > 0
      || entry.timer !== null
      || entry.queuedRevision !== null
      || isDirty(entry.dirty)
      || hasPendingHydration(presetId)
    ) return
    entries.delete(presetId)
    if (listenersByPreset.get(presetId) === entry.listeners) {
      listenersByPreset.delete(presetId)
    }
  }

  function enqueuePersist(presetId: string, entry: PresetSaveEntry): Promise<LoomPreset> {
    if (!isDirty(entry.dirty)) return entry.chain
    if (entry.queuedRevision === entry.revision) return entry.chain

    const revision = entry.revision
    const snapshot = clone(entry.draft)
    entry.queuedRevision = revision
    entry.queuedSnapshot = clone(snapshot)
    const enqueueEpoch = scopeEpoch
    const previous = entry.chain.catch(() => entry.confirmed)
    const link = previous.then(async () => {
      let pendingSnapshot = snapshot
      let conflictRetries = 0
      let conflictBase: LoomPreset | null = null

      while (true) {
        if (scopeEpoch !== enqueueEpoch || entries.get(presetId) !== entry) {
          return clone(entry.confirmed)
        }

        try {
          if (scopeEpoch !== enqueueEpoch || entries.get(presetId) !== entry) {
            return clone(entry.confirmed)
          }
          pendingSnapshot = rebaseDirtyPaths(entry.confirmed, pendingSnapshot, entry.dirty)
          if (!entry.queuedSnapshots.some((queued) => (
            sameJson(canonicalPersistedPayload(queued), canonicalPersistedPayload(pendingSnapshot))
          ))) {
            entry.queuedSnapshots.push(clone(pendingSnapshot))
          }
          conflictBase = clone(entry.confirmed)
          const savedRow = await adapter.update(presetId, marshalUpdate(pendingSnapshot))
          const current = entries.get(presetId)
          if (scopeEpoch !== enqueueEpoch || current !== entry) {
            return clone(entry.confirmed)
          }
          const responseSource = current.queuedSnapshot ?? pendingSnapshot
          const saved = preserveResponseState(
            unmarshalPreset(savedRow),
            responseSource,
            savedRow,
          )

          current.confirmed = clone(saved)
          rememberConfirmedCacheRevision(presetId, saved)
          if (current.revision === revision) {
            current.draft = clone(saved)
            current.dirty = emptyDirtyPaths()
          } else {
            const rebased = confirmPersistedDirtyPaths(saved, current.draft, current.dirty)
            current.draft = rebased.draft
            current.dirty = rebased.dirty
          }
          advanceConfirmedEpoch(presetId)
          writePendingEnvelope(presetId, current, pendingStorageScope)
          publish(current)
          return saved
        } catch (error) {
          if (scopeEpoch !== enqueueEpoch || entries.get(presetId) !== entry) {
            return clone(entry.confirmed)
          }
          if (!isRevisionConflict(error) || !adapter.get || conflictRetries >= MAX_REVISION_CONFLICT_RETRIES) {
            throw error
          }

          conflictRetries += 1
          let latestRow: Preset
          try {
            latestRow = await adapter.get(presetId)
          } catch (readError) {
            if (scopeEpoch !== enqueueEpoch || entries.get(presetId) !== entry) {
              return clone(entry.confirmed)
            }
            throw readError
          }
          if (scopeEpoch !== enqueueEpoch || entries.get(presetId) !== entry) {
            return clone(entry.confirmed)
          }
          const latest = unmarshalPreset(latestRow)
          const current = entries.get(presetId)
          if (
            entry.dirty.fields.includes('blocks')
            && !sameJson(latest.blocks, conflictBase!.blocks)
          ) {
            // Block arrays need block-id/property-aware merging. Until that
            // merge exists, surface only conflicts that changed blocks
            // remotely; unrelated persisted fields can still be rebased.
            throw error
          }
          if (scopeEpoch !== enqueueEpoch || current !== entry) {
            return clone(entry.confirmed)
          }

          current.confirmed = clone(latest)
          const rebased = rebaseDirtyPaths(latest, current.draft, current.dirty)
          current.draft = rebased
          advanceConfirmedEpoch(presetId)
          writePendingEnvelope(presetId, current, pendingStorageScope)
          publish(current)
          pendingSnapshot = clone(current.draft)
          current.queuedSnapshot = clone(pendingSnapshot)
        }
      }
    })
    entry.chain = link
    link.then(
      () => {
        const current = entries.get(presetId)
        if (scopeEpoch === enqueueEpoch && current === entry && current.queuedRevision === revision) {
          current.queuedRevision = null
          current.queuedSnapshot = null
          current.queuedSnapshots = []
          evictCleanEntry(presetId)
        }
      },
      () => {
        const current = entries.get(presetId)
        if (scopeEpoch === enqueueEpoch && current === entry && current.queuedRevision === revision) {
          current.queuedRevision = null
          current.queuedSnapshot = null
          current.queuedSnapshots = []
          evictCleanEntry(presetId)
        }
      },
    )
    link.catch(() => {})
    return link
  }

  function queueDebouncedSave(presetId: string, entry: PresetSaveEntry, debounceMs: number): void {
    clearTimeout(entry.timer)
    entry.timer = globalThis.setTimeout(() => {
      entry.timer = null
      void enqueuePersist(presetId, entry).catch(() => {})
    }, debounceMs)
  }

  return {
    setScope(nextScope: string | null): void {
      if (pendingStorageScope === nextScope) return
      pendingStorageScope = nextScope
      scopeEpoch += 1
      discardScopeState()
    },

    getScopeEpoch(): number {
      return scopeEpoch
    },
    beginHydration(presetId, owner = 'default'): PresetHydrationToken {
      const reservation = reserveHydrationRead(presetId, owner)
      const token = {
        presetId,
        owner,
        readEpoch: reservation.readEpoch,
        globalReadEpoch: reservation.globalReadEpoch,
        confirmedEpoch: getConfirmedEpoch(presetId),
        scopeEpoch,
      }
      pendingHydrations.add(token)
      return token
    },

    cancelHydration(token): void {
      if (pendingHydrations.delete(token)) evictCleanEntry(token.presetId)
    },

    hydrate(preset, token): LoomPreset {
      try {
      // Read ordering and confirmed persistence are independent: a local dirty
      // mutation may rebase over the newest read, but an older read cannot
      // replace a subsequently confirmed persisted row. A non-authoritative
      // consumer read remains a valid fallback until the latest consumer read
      // succeeds, so one failed auxiliary load cannot blank the active editor.
      if (token && token.scopeEpoch !== scopeEpoch) {
        throw new PresetScopeChangedError()
      }
      if (token && (
        token.presetId !== preset.id
        || token.readEpoch !== getHydrationReadEpoch(preset.id, token.owner)
        || token.confirmedEpoch !== getConfirmedEpoch(preset.id)
      )) {
        const current = entries.get(preset.id)
        if (current) return clone(current.draft)
        throw new StalePresetHydrationError(preset.id)
      }
      if (!entries.has(preset.id)) migrateLegacyPendingEnvelope(preset.id, pendingStorageScope)
      const existingEntry = entries.get(preset.id)
      const residentCacheRevision = existingEntry?.confirmed.cacheRevision
      const rememberedCacheRevision = confirmedCacheRevisions.get(preset.id)
      const confirmedCacheRevision = residentCacheRevision === undefined
        ? rememberedCacheRevision
        : rememberedCacheRevision === undefined
          ? residentCacheRevision
          : Math.max(residentCacheRevision, rememberedCacheRevision)
      const staleTokenlessEcho = !token
        && typeof preset.cacheRevision === 'number'
        && typeof confirmedCacheRevision === 'number'
        && preset.cacheRevision < confirmedCacheRevision
      if (staleTokenlessEcho) {
        if (
          existingEntry
          && (rememberedCacheRevision === undefined
            || residentCacheRevision === rememberedCacheRevision)
        ) {
          return clone(existingEntry.draft)
        }
        const confirmedSnapshot = confirmedSnapshots.get(preset.id)
        if (confirmedSnapshot) {
          if (existingEntry) {
            existingEntry.confirmed = clone(confirmedSnapshot)
            existingEntry.draft = isDirty(existingEntry.dirty)
              ? rebaseDirtyPaths(confirmedSnapshot, existingEntry.draft, existingEntry.dirty)
              : clone(confirmedSnapshot)
            writePendingEnvelope(preset.id, existingEntry, pendingStorageScope)
            publish(existingEntry)
            return clone(existingEntry.draft)
          }
          return clone(confirmedSnapshot)
        }
        if (existingEntry) return clone(existingEntry.draft)
        throw new StalePresetHydrationError(preset.id)
      }
      if (!token) advanceConfirmedEpoch(preset.id)
      const isAuthoritativeRead = !token
        || token.globalReadEpoch === (latestHydrationReadEpochs.get(preset.id) ?? 0)
      const entry = entries.get(preset.id)
      if (!entry) {
        const created = ensure(preset.id, preset)
        if (token && isAuthoritativeRead) advanceConfirmedEpoch(preset.id)
        publish(created)
        if (!token) evictCleanEntry(preset.id)
        return clone(created.draft)
      }

      if (
        typeof preset.cacheRevision === 'number'
        && typeof entry.confirmed.cacheRevision === 'number'
        && preset.cacheRevision < entry.confirmed.cacheRevision
      ) {
        // A late echo for an older queued write cannot regress the confirmed
        // revision while a newer dispatch is still in flight.
        return clone(entry.draft)
      }
      if (
        entry.queuedRevision !== null
        && entry.queuedSnapshots.some((queued) => (
          sameJson(canonicalPersistedPayload(queued), canonicalPersistedPayload(preset))
        ))
      ) {
        entry.confirmed = clone(preset)
        rememberConfirmedCacheRevision(preset.id, preset)
        entry.draft = isDirty(entry.dirty)
          ? rebaseDirtyPaths(preset, entry.draft, entry.dirty)
          : clone(preset)
        entry.queuedSnapshot = clone(entry.draft)
        if (token && isAuthoritativeRead) advanceConfirmedEpoch(preset.id)
        writePendingEnvelope(preset.id, entry, pendingStorageScope)
        publish(entry)
        return clone(entry.draft)
      }
      if (
        entry.dirty.fields.includes('blocks')
        && !sameJson(preset.blocks, entry.confirmed.blocks)
      ) {
        throw new PresetBlockConflictError(preset.id)
      }
      const persistedChanged = !sameJson(entry.confirmed, preset)
      const rebased = isDirty(entry.dirty)
        ? confirmPersistedDirtyPaths(preset, entry.draft, entry.dirty)
        : { draft: clone(preset), dirty: emptyDirtyPaths() }
      entry.confirmed = clone(preset)
      rememberConfirmedCacheRevision(preset.id, preset)
      entry.draft = rebased.draft
      entry.dirty = rebased.dirty
      if (isDirty(entry.dirty) && persistedChanged) {
        entry.revision += 1
      }
      if (token && isAuthoritativeRead) advanceConfirmedEpoch(preset.id)
      writePendingEnvelope(preset.id, entry, pendingStorageScope)
      publish(entry)
      if (isDirty(entry.dirty) && persistedChanged) {
        void enqueuePersist(preset.id, entry).catch(() => {})
      }
      if (!token && !isDirty(entry.dirty)) evictCleanEntry(preset.id)
      return clone(entry.draft)
      } finally {
        if (token && pendingHydrations.delete(token)) {
          evictCleanEntry(token.presetId)
        }
      }
    },

    getDraft(presetId: string): LoomPreset | null {
      const entry = entries.get(presetId)
      return entry ? clone(entry.draft) : null
    },

    hasPendingChanges(presetId: string): boolean {
      return Boolean(entries.get(presetId) && isDirty(entries.get(presetId)!.dirty))
    },

    hasDurablePendingRecovery(presetId: string): boolean {
      return !entries.has(presetId) && readPendingEnvelope(presetId, pendingStorageScope) !== null
    },

    mutate(presetId, fallback, mutator, options = {}): LoomPreset {
      const entry = ensure(presetId, fallback)
      const before = entry.draft
      const after = mutator(clone(before))
      if (!after || after.id !== presetId) throw new Error('Preset mutations must preserve the active preset id')

      const changed = getChangedPaths(before, after)
      if (!isDirty(changed)) return clone(before)

      const confirmedCacheRevision = before.cacheRevision
      entry.draft = clone({
        ...after,
        updatedAt: Date.now(),
        ...(typeof confirmedCacheRevision === 'number'
          ? { cacheRevision: confirmedCacheRevision }
          : {}),
      })
      entry.dirty = mergeDirtyPaths(entry.dirty, changed)
      entry.revision += 1
      // Dirty local paths intentionally remain compatible with an in-flight
      // latest read; hydrate() rebases them over its fresh persisted base.
      writePendingEnvelope(presetId, entry, pendingStorageScope)
      publish(entry)

      if (options.immediate) {
        void enqueuePersist(presetId, entry).catch(() => {})
      } else {
        queueDebouncedSave(presetId, entry, options.debounceMs ?? 400)
      }
      return clone(entry.draft)
    },

    async flush(presetId: string): Promise<LoomPreset | null> {
      while (true) {
        const entry = entries.get(presetId)
        if (!entry) return null
        if (entry.timer) {
          clearTimeout(entry.timer)
          entry.timer = null
        }

        const revision = entry.revision
        const chain = isDirty(entry.dirty) ? enqueuePersist(presetId, entry) : entry.chain
        const saved = await chain
        const current = entries.get(presetId)
        if (!current) return saved
        if (current.revision === revision && !isDirty(current.dirty) && current.chain === chain) {
          return saved
        }
      }
    },

    flushBestEffort(presetId: string): void {
      void this.flush(presetId).catch(() => {})
    },

    subscribe(presetId, listener): () => void {
      const listeners = listenersByPreset.get(presetId) ?? new Set<(preset: LoomPreset) => void>()
      listenersByPreset.set(presetId, listeners)
      listeners.add(listener)
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return
        if (!entries.has(presetId) && listenersByPreset.get(presetId) === listeners) {
          listenersByPreset.delete(presetId)
          return
        }
        evictCleanEntry(presetId)
      }
    },

    remove(presetId: string): void {
      const entry = entries.get(presetId)
      clearTimeout(entry?.timer)
      confirmedCacheRevisions.delete(presetId)
      confirmedSnapshots.delete(presetId)
      entries.delete(presetId)
      advanceConfirmedEpoch(presetId)
      listenersByPreset.delete(presetId)
      removePendingEnvelope(presetId, pendingStorageScope)
    },
  }
}

export const presetSaveCoordinator = createPresetSaveCoordinator({
  update: (presetId, input) => presetsApi.update(presetId, input),
  get: (presetId) => presetsApi.get(presetId),
})

const durableRecoveryFlushes = new Map<string, Promise<void>>()
export function setPresetSaveCoordinatorScope(scope: string | null): void {
  const previousScopeEpoch = presetSaveCoordinator.getScopeEpoch()
  presetSaveCoordinator.setScope(scope)
  if (presetSaveCoordinator.getScopeEpoch() !== previousScopeEpoch) {
    durableRecoveryFlushes.clear()
  }
}
export async function flushPresetForGeneration(presetId: string | undefined): Promise<void> {
  if (!presetId) return
  const scopeEpoch = presetSaveCoordinator.getScopeEpoch()
  const assertScope = (): void => {
    if (presetSaveCoordinator.getScopeEpoch() !== scopeEpoch) {
      throw new PresetScopeChangedError()
    }
  }
  if (!presetSaveCoordinator.hasDurablePendingRecovery(presetId)) {
    await presetSaveCoordinator.flush(presetId)
    assertScope()
    return
  }

  const existingRecovery = durableRecoveryFlushes.get(presetId)
  if (existingRecovery) {
    await existingRecovery
    assertScope()
    return
  }

  const recovery = (async () => {
    while (true) {
      assertScope()
      const hydration = presetSaveCoordinator.beginHydration(presetId, 'durable-recovery')
      try {
        const persisted = unmarshalPreset(await presetsApi.get(presetId))
        assertScope()
        presetSaveCoordinator.hydrate(persisted, hydration)
        break
      } catch (error) {
        presetSaveCoordinator.cancelHydration(hydration)
        assertScope()
        if (!(error instanceof StalePresetHydrationError)) throw error
      }
    }
    await presetSaveCoordinator.flush(presetId)
    assertScope()
  })()
  durableRecoveryFlushes.set(presetId, recovery)
  try {
    await recovery
  } finally {
    if (durableRecoveryFlushes.get(presetId) === recovery) {
      durableRecoveryFlushes.delete(presetId)
    }
  }
}
