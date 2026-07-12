import { presetsApi } from '@/api/presets'
import type { Preset, UpdatePresetInput } from '@/types/api'
import { looksLikeLoomPresetData, marshalUpdate, unmarshalPreset } from './service'
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

export interface PresetSaveCoordinator {
  /**
   * Incorporate a freshly read persisted row. Any durable or in-memory dirty
   * paths are rebased over that row; untouched paths always come from the row.
   */
  hydrate(preset: LoomPreset): LoomPreset
  /** Return the current per-preset draft, if this coordinator owns one. */
  getDraft(presetId: string): LoomPreset | null
  /** True when the preset has unsaved local changes. */
  hasPendingChanges(presetId: string): boolean
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
  if (!value.fields.every(isDraftField) || !value.passthroughKeys.every((key) => typeof key === 'string')) return null
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
  return { fields, passthroughKeys: [] }
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
    const pending = readPendingEnvelope(presetId)
    if (pending) {
      entry.draft = rebaseDirtyPaths(fallback, pending.preset, pending.dirty)
      entry.dirty = pending.dirty
      entry.revision = pending.revision
    }
    entries.set(presetId, entry)
    return entry
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
      writePendingEnvelope(presetId, current)
      publish(current)
      return saved
    })
    entry.chain = link
    link.then(
      () => {
        const current = entries.get(presetId)
        if (current?.queuedRevision === revision) current.queuedRevision = null
      },
      () => {
        const current = entries.get(presetId)
        if (current?.queuedRevision === revision) current.queuedRevision = null
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
    hydrate(preset: LoomPreset): LoomPreset {
      const entry = entries.get(preset.id)
      if (!entry) {
        const created = ensure(preset.id, preset)
        if (isDirty(created.dirty)) void enqueuePersist(preset.id, created).catch(() => {})
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
      writePendingEnvelope(preset.id, entry)
      publish(entry)
      if (isDirty(entry.dirty) && persistedChanged) {
        void enqueuePersist(preset.id, entry).catch(() => {})
      }
      return clone(entry.draft)
    },

    getDraft(presetId: string): LoomPreset | null {
      const entry = entries.get(presetId)
      return entry ? clone(entry.draft) : null
    },

    hasPendingChanges(presetId: string): boolean {
      return Boolean(entries.get(presetId) && isDirty(entries.get(presetId)!.dirty))
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
      const entry = entries.get(presetId)
      if (!entry) return null
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      if (isDirty(entry.dirty)) return enqueuePersist(presetId, entry)
      return entry.chain
    },

    flushBestEffort(presetId: string): void {
      void this.flush(presetId).catch(() => {})
    },

    subscribe(presetId, listener): () => void {
      const entry = entries.get(presetId)
      if (!entry) return () => {}
      entry.listeners.add(listener)
      return () => { entry.listeners.delete(listener) }
    },

    remove(presetId: string): void {
      const entry = entries.get(presetId)
      clearTimeout(entry?.timer)
      entries.delete(presetId)
      removePendingEnvelope(presetId)
    },
  }
}

export const presetSaveCoordinator = createPresetSaveCoordinator({
  update: (presetId, input) => presetsApi.update(presetId, input),
})

/** Await the active preset's latest draft before a generation endpoint reads it. */
export async function flushPresetForGeneration(presetId: string | undefined): Promise<void> {
  if (!presetId) return
  await presetSaveCoordinator.flush(presetId)
}
