import { presetsApi } from '@/api/presets'
import type { Preset, UpdatePresetInput } from '@/types/api'
import { looksLikeLoomPresetData, marshalUpdate, SPINDLE_EXTENSION_METADATA_KEY, unmarshalPreset } from './service'
import type { LoomPreset } from './types'

const PENDING_LOOM_PRESETS_KEY = '__lumiverse_pending_loom_presets'
const PENDING_LOOM_PRESET_ENVELOPE_KEY = '__lumiverse_pending_loom_preset_v2'

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
  spindleMetadataKeys: string[]
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
  listeners: Set<(preset: LoomPreset) => void>
}

export interface PresetSaveAdapter {
  update(presetId: string, input: UpdatePresetInput): Promise<Preset>
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
}

export class StalePresetHydrationError extends Error {
  constructor(presetId: string) {
    super(`Stale preset hydration: ${presetId}`)
    this.name = 'StalePresetHydrationError'
  }
}

export interface PresetSaveCoordinator {
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

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isDraftField(value: unknown): value is DraftField {
  return typeof value === 'string' && (DRAFT_FIELDS as readonly string[]).includes(value)
}

function normalizeDirtyPaths(value: unknown): DirtyPresetPaths | null {
  if (!isRecord(value) || !Array.isArray(value.fields) || !Array.isArray(value.passthroughKeys)) return null
  const spindleMetadataKeys = value.spindleMetadataKeys === undefined
    ? []
    : value.spindleMetadataKeys
  if (
    !value.fields.every(isDraftField)
    || !value.passthroughKeys.every((key) => typeof key === 'string')
    || !Array.isArray(spindleMetadataKeys)
    || !spindleMetadataKeys.every((key) => typeof key === 'string')
  ) return null
  return {
    fields: [...new Set(value.fields)],
    passthroughKeys: [...new Set(value.passthroughKeys)],
    spindleMetadataKeys: [...new Set(spindleMetadataKeys)],
  }
}

function isDirty(dirty: DirtyPresetPaths): boolean {
  return dirty.fields.length > 0 || dirty.passthroughKeys.length > 0 || dirty.spindleMetadataKeys.length > 0
}

function emptyDirtyPaths(): DirtyPresetPaths {
  return { fields: [], passthroughKeys: [], spindleMetadataKeys: [] }
}

function mergeDirtyPaths(previous: DirtyPresetPaths, next: DirtyPresetPaths): DirtyPresetPaths {
  return {
    fields: [...new Set([...previous.fields, ...next.fields])],
    passthroughKeys: [...new Set([...previous.passthroughKeys, ...next.passthroughKeys])],
    spindleMetadataKeys: [...new Set([...previous.spindleMetadataKeys, ...next.spindleMetadataKeys])],
  }
}

function getChangedPaths(before: LoomPreset, after: LoomPreset): DirtyPresetPaths {
  const fields = DRAFT_FIELDS.filter((field) => !sameJson(before[field], after[field]))
  const beforeMetadata = before.passthroughMetadata ?? {}
  const afterMetadata = after.passthroughMetadata ?? {}
  const beforeNamespaces = isRecord(beforeMetadata[SPINDLE_EXTENSION_METADATA_KEY])
    ? beforeMetadata[SPINDLE_EXTENSION_METADATA_KEY]
    : {}
  const afterNamespaces = isRecord(afterMetadata[SPINDLE_EXTENSION_METADATA_KEY])
    ? afterMetadata[SPINDLE_EXTENSION_METADATA_KEY]
    : {}
  const spindleMetadataKeys = [...new Set([
    ...Object.keys(beforeNamespaces),
    ...Object.keys(afterNamespaces),
  ])].filter((key) => !sameJson(beforeNamespaces[key], afterNamespaces[key]))
  const passthroughKeys = [...new Set([
    ...Object.keys(beforeMetadata),
    ...Object.keys(afterMetadata),
  ])].filter((key) => key !== SPINDLE_EXTENSION_METADATA_KEY && !sameJson(beforeMetadata[key], afterMetadata[key]))

  return { fields, passthroughKeys, spindleMetadataKeys }
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

  if (dirty.passthroughKeys.length > 0 || dirty.spindleMetadataKeys.length > 0) {
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

    if (dirty.spindleMetadataKeys.length > 0) {
      const namespaces = isRecord(metadata[SPINDLE_EXTENSION_METADATA_KEY])
        ? clone(metadata[SPINDLE_EXTENSION_METADATA_KEY])
        : {}
      const draftNamespaces = isRecord(draft.passthroughMetadata[SPINDLE_EXTENSION_METADATA_KEY])
        ? draft.passthroughMetadata[SPINDLE_EXTENSION_METADATA_KEY]
        : {}
      for (const extensionId of dirty.spindleMetadataKeys) {
        if (Object.hasOwn(draftNamespaces, extensionId)) {
          Object.defineProperty(namespaces, extensionId, {
            value: clone(draftNamespaces[extensionId]),
            enumerable: true,
            writable: true,
            configurable: true,
          })
        } else {
          delete namespaces[extensionId]
        }
      }
      Object.defineProperty(metadata, SPINDLE_EXTENSION_METADATA_KEY, {
        value: namespaces,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    rebased.passthroughMetadata = metadata
  }

  return rebased
}

function readPendingEntries(): Record<string, unknown> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = globalThis.localStorage.getItem(PENDING_LOOM_PRESETS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writePendingEntries(entries: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(entries).length === 0) {
      globalThis.localStorage.removeItem(PENDING_LOOM_PRESETS_KEY)
      return
    }
    globalThis.localStorage.setItem(PENDING_LOOM_PRESETS_KEY, JSON.stringify(entries))
  } catch {
    // Recovery is best-effort; the in-memory coordinator still serializes work.
  }
}


function legacyDirtyPaths(includePromptVariables: boolean): DirtyPresetPaths {
  const fields: DraftField[] = DRAFT_FIELDS.filter((field) => (
    field !== 'promptVariables'
    && field !== 'lumihubMeta'
    && field !== 'presetVersion'
  ))
  if (includePromptVariables) fields.push('promptVariables')
  return { fields, passthroughKeys: [], spindleMetadataKeys: [] }
}
function readPendingEnvelope(presetId: string): PendingLoomPresetEnvelope | null {
  const entry = readPendingEntries()[presetId]
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
        : { fields: includePromptVariables ? ['promptVariables'] : [], passthroughKeys: [], spindleMetadataKeys: [] },
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

function writePendingEnvelope(presetId: string, entry: PresetSaveEntry): void {
  const all = readPendingEntries()
  if (!isDirty(entry.dirty)) {
    delete all[presetId]
    writePendingEntries(all)
    return
  }

  const envelope: PendingLoomPresetEnvelope = {
    [PENDING_LOOM_PRESET_ENVELOPE_KEY]: 2,
    preset: entry.draft,
    dirty: entry.dirty,
    revision: entry.revision,
  }
  all[presetId] = envelope
  writePendingEntries(all)
}

function removePendingEnvelope(presetId: string): void {
  const all = readPendingEntries()
  if (!(presetId in all)) return
  delete all[presetId]
  writePendingEntries(all)
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
  const pendingHydrations = new Set<PresetHydrationToken>()

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

    const entry = createEntry(fallback)
    entry.listeners = listenersByPreset.get(presetId) ?? new Set()
    listenersByPreset.set(presetId, entry.listeners)
    const pending = readPendingEnvelope(presetId)
    if (pending) {
      entry.draft = rebaseDirtyPaths(fallback, pending.preset, pending.dirty)
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
    const previous = entry.chain.catch(() => entry.confirmed)
    const link = previous.then(async () => {
      const saved = unmarshalPreset(await adapter.update(presetId, marshalUpdate(snapshot)))
      const current = entries.get(presetId)
      if (!current) return saved

      current.confirmed = clone(saved)
      if (current.revision === revision) {
        current.draft = clone(saved)
        current.dirty = emptyDirtyPaths()
      } else {
        current.draft = rebaseDirtyPaths(saved, current.draft, current.dirty)
      }
      advanceConfirmedEpoch(presetId)
      writePendingEnvelope(presetId, current)
      publish(current)
      return saved
    })
    entry.chain = link
    link.then(
      () => {
        const current = entries.get(presetId)
        if (current?.queuedRevision === revision) {
          current.queuedRevision = null
        }
      },
      () => {
        const current = entries.get(presetId)
        if (current?.queuedRevision === revision) {
          current.queuedRevision = null
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
    beginHydration(presetId, owner = 'default'): PresetHydrationToken {
      const reservation = reserveHydrationRead(presetId, owner)
      const token = {
        presetId,
        owner,
        readEpoch: reservation.readEpoch,
        globalReadEpoch: reservation.globalReadEpoch,
        confirmedEpoch: getConfirmedEpoch(presetId),
      }
      pendingHydrations.add(token)
      return token
    },

    cancelHydration(token): void {
      if (pendingHydrations.delete(token)) evictCleanEntry(token.presetId)
    },

    hydrate(preset, token): LoomPreset {
      let isStaleHydration = false
      try {
      // Read ordering and confirmed persistence are independent: a local dirty
      // mutation may rebase over the newest read, but an older read cannot
      // replace a subsequently confirmed persisted row. A non-authoritative
      // consumer read remains a valid fallback until the latest consumer read
      // succeeds, so one failed auxiliary load cannot blank the active editor.
      if (!token) advanceConfirmedEpoch(preset.id)
      if (token && (
        token.presetId !== preset.id
        || token.readEpoch !== getHydrationReadEpoch(preset.id, token.owner)
        || token.confirmedEpoch !== getConfirmedEpoch(preset.id)
      )) {
        isStaleHydration = true
        const current = entries.get(preset.id)
        if (current) return clone(current.draft)
        throw new StalePresetHydrationError(preset.id)
      }
      const isAuthoritativeRead = !token
        || token.globalReadEpoch === (latestHydrationReadEpochs.get(preset.id) ?? 0)
      const entry = entries.get(preset.id)
      if (!entry) {
        const created = ensure(preset.id, preset)
        if (token && isAuthoritativeRead) advanceConfirmedEpoch(preset.id)
        publish(created)
        return clone(created.draft)
      }

      const persistedChanged = !sameJson(entry.confirmed, preset)
      entry.confirmed = clone(preset)
      entry.draft = isDirty(entry.dirty)
        ? rebaseDirtyPaths(preset, entry.draft, entry.dirty)
        : clone(preset)
      if (isDirty(entry.dirty) && persistedChanged) {
        entry.revision += 1
      }
      if (token && isAuthoritativeRead) advanceConfirmedEpoch(preset.id)
      writePendingEnvelope(preset.id, entry)
      publish(entry)
      if (isDirty(entry.dirty) && persistedChanged) {
        void enqueuePersist(preset.id, entry).catch(() => {})
      }
      return clone(entry.draft)
      } finally {
        if (token && pendingHydrations.delete(token) && !isStaleHydration) {
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
      return !entries.has(presetId) && readPendingEnvelope(presetId) !== null
    },

    mutate(presetId, fallback, mutator, options = {}): LoomPreset {
      const entry = ensure(presetId, fallback)
      const before = entry.draft
      const after = mutator(clone(before))
      if (!after || after.id !== presetId) throw new Error('Preset mutations must preserve the active preset id')

      const changed = getChangedPaths(before, after)
      if (!isDirty(changed)) return clone(before)

      entry.draft = clone({ ...after, updatedAt: Date.now() })
      entry.dirty = mergeDirtyPaths(entry.dirty, changed)
      entry.revision += 1
      // Dirty local paths intentionally remain compatible with an in-flight
      // latest read; hydrate() rebases them over its fresh persisted base.
      writePendingEnvelope(presetId, entry)
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
      entries.delete(presetId)
      advanceConfirmedEpoch(presetId)
      listenersByPreset.delete(presetId)
      removePendingEnvelope(presetId)
    },
  }
}

export const presetSaveCoordinator = createPresetSaveCoordinator({
  update: (presetId, input) => presetsApi.update(presetId, input),
})

const durableRecoveryFlushes = new Map<string, Promise<void>>()

/**
 * Await the selected preset's latest draft before generation reads it. When
 * Loom has not mounted yet, hydrate durable recovery state over a fresh row
 * first so prompt-only or scoped writes cannot be skipped.
 */
export async function flushPresetForGeneration(presetId: string | undefined): Promise<void> {
  if (!presetId) return
  if (!presetSaveCoordinator.hasDurablePendingRecovery(presetId)) {
    await presetSaveCoordinator.flush(presetId)
    return
  }

  const existingRecovery = durableRecoveryFlushes.get(presetId)
  if (existingRecovery) {
    await existingRecovery
    return
  }

  const recovery = (async () => {
    while (true) {
      const hydration = presetSaveCoordinator.beginHydration(presetId, 'durable-recovery')
      try {
        const persisted = unmarshalPreset(await presetsApi.get(presetId))
        presetSaveCoordinator.hydrate(persisted, hydration)
        break
      } catch (error) {
        presetSaveCoordinator.cancelHydration(hydration)
        if (!(error instanceof StalePresetHydrationError)) throw error
      }
    }
    await presetSaveCoordinator.flush(presetId)
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
