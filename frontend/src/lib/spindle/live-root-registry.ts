export type LiveRootPermission = 'characters' | 'ui_panels' | 'app_manipulation' | 'presets' | null

export interface LiveRootRecord {
  readonly root: Element
  readonly extensionId: string
  readonly permission: LiveRootPermission
  readonly generation?: number
}

type RootListener = () => void

const records = new Map<Element, LiveRootRecord>()
const recordsByExtension = new Map<string, Set<Element>>()
const listenersByRoot = new Map<Element, Set<RootListener>>()

function sameRecord(
  record: LiveRootRecord,
  extensionId: string,
  permission: LiveRootPermission,
  generation: number | undefined,
): boolean {
  return record.extensionId === extensionId
    && record.permission === permission
    && record.generation === generation
}

/**
 * Register one extension-owned DOM root.
 *
 * Permission-bearing roots must carry the loader generation that created them.
 * Permission-free roots (modals and DOM injections) still carry the generation
 * when created by the loader; `undefined` remains available only to direct
 * host callers that intentionally create an unversioned, permission-free root.
 */
export function registerLiveRoot(
  extensionId: string,
  root: Element,
  permission: LiveRootPermission = null,
  generation?: number,
): () => void {
  if (!(root instanceof Element)) {
    throw new Error('SPINDLE_ROOT_INVALID: root must be a DOM Element')
  }
  if (permission !== null && generation === undefined) {
    throw new Error('SPINDLE_ROOT_GENERATION_REQUIRED: permission-bearing roots require a generation')
  }

  const existing = records.get(root)
  if (existing && !sameRecord(existing, extensionId, permission, generation)) {
    throw new Error('SPINDLE_ROOT_CONFLICT: root is already registered')
  }
  if (!existing) {
    const record: LiveRootRecord = Object.freeze({ root, extensionId, permission, generation })
    records.set(root, record)
    const roots = recordsByExtension.get(extensionId) ?? new Set<Element>()
    roots.add(root)
    recordsByExtension.set(extensionId, roots)
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    unregisterLiveRoot(root, extensionId, generation)
  }
}

export function unregisterLiveRoot(root: Element, extensionId?: string, generation?: number): void {
  const record = records.get(root)
  if (!record) return
  if (extensionId !== undefined && record.extensionId !== extensionId) return
  if (generation !== undefined && record.generation !== generation) return

  records.delete(root)
  const listeners = listenersByRoot.get(root)
  listenersByRoot.delete(root)
  const roots = recordsByExtension.get(record.extensionId)
  roots?.delete(root)
  if (roots && roots.size === 0) recordsByExtension.delete(record.extensionId)
  for (const listener of listeners ?? []) {
    try { listener() } catch { /* no-op */ }
  }
}

export function clearLiveRootsForExtension(extensionId: string, generation?: number): void {
  const roots = recordsByExtension.get(extensionId)
  if (!roots) return
  for (const root of [...roots]) {
    unregisterLiveRoot(root, extensionId, generation)
  }
}

/**
 * Resolve the nearest registered root owned by `extensionId`. If
 * `expectedGeneration` is supplied, an unversioned or differently-versioned
 * root is rejected.
 */
export function getLiveRootRecord(
  extensionId: string,
  element: Element,
  expectedGeneration?: number,
): LiveRootRecord | null {
  let current: Element | null = element
  while (current) {
    const record = records.get(current)
    if (!record) {
      current = current.parentElement
      continue
    }
    if (record.extensionId !== extensionId) return null
    if (expectedGeneration !== undefined && record.generation !== expectedGeneration) return null
    return record
  }
  return null
}

export function getLiveRootRecordExact(
  extensionId: string,
  root: Element,
  expectedGeneration?: number,
): LiveRootRecord | null {
  const record = records.get(root)
  if (!record || record.extensionId !== extensionId) return null
  if (expectedGeneration !== undefined && record.generation !== expectedGeneration) return null
  return record
}

export function subscribeLiveRoot(root: Element, listener: RootListener): () => void {
  const listeners = listenersByRoot.get(root) ?? new Set<RootListener>()
  listeners.add(listener)
  listenersByRoot.set(root, listeners)
  let active = true
  return () => {
    if (!active) return
    active = false
    listeners.delete(listener)
    if (listeners.size === 0) listenersByRoot.delete(root)
  }
}
