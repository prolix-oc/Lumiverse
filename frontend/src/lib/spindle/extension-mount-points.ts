import type { SpindleMountPoint } from 'lumiverse-spindle-types'
import type { WidenedMountPoint } from './mount-points'

// UI observers must not import the loader, which itself loads native panels.
const extensionMountPoints = new Map<string, Set<WidenedMountPoint>>()
const listeners = new Set<() => void>()
let version = 0

function notify(): void {
  version += 1
  for (const listener of listeners) {
    try { listener() }
    catch (error) { console.error('[Spindle] Extension mount-point listener error:', error) }
  }
}

export function recordExtensionMountPoint(extensionId: string, point: WidenedMountPoint): void {
  const existing = extensionMountPoints.get(extensionId)
  if (existing?.has(point)) return
  const next = existing ? new Set(existing) : new Set<WidenedMountPoint>()
  next.add(point)
  extensionMountPoints.set(extensionId, next)
  notify()
}

export function clearExtensionMountPoints(extensionId: string): void {
  if (extensionMountPoints.delete(extensionId)) notify()
}

export function hasExtensionMountPoint(extensionId: string, point: SpindleMountPoint): boolean {
  return extensionMountPoints.get(extensionId)?.has(point) ?? false
}

export function subscribeExtensionMountPoints(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getExtensionMountPointsVersion(): number {
  return version
}
