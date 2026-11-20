import type { ExtensionInfo } from 'lumiverse-spindle-types'

export const MESSAGE_TAG_INTERCEPTOR_RUNTIME_CAPABILITY = 'message_tag_interceptor'

type ExtensionWithRuntimeCapabilities = ExtensionInfo & {
  frontend_runtime_capabilities?: unknown
}

export type FrontendRuntimeCapabilityChange = {
  action: 'registered' | 'unregistered'
  extensionId: string
  capability: string
}

let snapshotReady = false
let visibleExtensionIds = new Set<string>()
let declaredExtensions = new Set<string>()
const attachedCounts = new Map<string, number>()
const queuedChanges: FrontendRuntimeCapabilityChange[] = []

export type MessageTagRuntimeReadinessDiagnostics = {
  ready: boolean
  snapshotReady: boolean
  visibleExtensionIds: string[]
  declaredExtensions: Array<{ extensionId: string; attachedCount: number }>
  attachedInterceptors: Array<{ extensionId: string; count: number }>
  missingExtensionIds: string[]
}

function hasMessageTagCapability(extension: ExtensionWithRuntimeCapabilities): boolean {
  return Array.isArray(extension.frontend_runtime_capabilities)
    && extension.frontend_runtime_capabilities.includes(MESSAGE_TAG_INTERCEPTOR_RUNTIME_CAPABILITY)
}

function applyChange(change: FrontendRuntimeCapabilityChange): void {
  if (change.capability !== MESSAGE_TAG_INTERCEPTOR_RUNTIME_CAPABILITY) return
  if (change.action === 'registered') declaredExtensions.add(change.extensionId)
  else declaredExtensions.delete(change.extensionId)
}

/** Install the authoritative capability snapshot carried by GET /spindle. */
export function reconcileMessageTagRuntimeCapabilities(extensions: ExtensionInfo[]): void {
  visibleExtensionIds = new Set(extensions.map((extension) => extension.id))
  declaredExtensions = new Set(
    extensions
      .filter((extension) => extension.enabled && extension.has_frontend)
      .filter((extension) => hasMessageTagCapability(extension as ExtensionWithRuntimeCapabilities))
      .map((extension) => extension.id),
  )
  snapshotReady = true
  const changes = queuedChanges.splice(0)
  for (const change of changes) {
    if (visibleExtensionIds.has(change.extensionId)) applyChange(change)
  }
}

/** Apply a live worker declaration/retraction after the list snapshot. */
export function applyMessageTagRuntimeCapabilityChange(
  change: FrontendRuntimeCapabilityChange,
  options: { visible?: boolean } = {},
): void {
  if (!snapshotReady) {
    queuedChanges.push(change)
    return
  }
  if (options.visible === false) return
  applyChange(change)
}

export function noteMessageTagInterceptorAttached(extensionId: string): void {
  attachedCounts.set(extensionId, (attachedCounts.get(extensionId) ?? 0) + 1)
}

export function noteMessageTagInterceptorDetached(extensionId: string): void {
  const count = attachedCounts.get(extensionId) ?? 0
  if (count <= 1) attachedCounts.delete(extensionId)
  else attachedCounts.set(extensionId, count - 1)
}

export function clearAttachedMessageTagInterceptors(extensionId: string): void {
  attachedCounts.delete(extensionId)
}

/** True once every declared interceptor-capable extension has attached. */
export function areMessageTagRuntimeInterceptorsReady(): boolean {
  if (!snapshotReady) return false
  for (const extensionId of declaredExtensions) {
    if ((attachedCounts.get(extensionId) ?? 0) === 0) return false
  }
  return true
}

/** Read-only state for diagnosing a chat reveal that reached its settle cap. */
export function getMessageTagRuntimeReadinessDiagnostics(): MessageTagRuntimeReadinessDiagnostics {
  const declared = [...declaredExtensions]
    .sort()
    .map((extensionId) => ({
      extensionId,
      attachedCount: attachedCounts.get(extensionId) ?? 0,
    }))
  return {
    ready: areMessageTagRuntimeInterceptorsReady(),
    snapshotReady,
    visibleExtensionIds: [...visibleExtensionIds].sort(),
    declaredExtensions: declared,
    attachedInterceptors: [...attachedCounts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([extensionId, count]) => ({ extensionId, count })),
    missingExtensionIds: declared
      .filter(({ attachedCount }) => attachedCount === 0)
      .map(({ extensionId }) => extensionId),
  }
}

export function resetMessageTagRuntimeReadinessForTests(): void {
  snapshotReady = false
  visibleExtensionIds = new Set()
  declaredExtensions = new Set()
  attachedCounts.clear()
  queuedChanges.splice(0)
}
