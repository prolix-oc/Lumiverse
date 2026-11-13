import { useSyncExternalStore } from 'react'

export type LorebookWorkspaceSurface = 'half' | 'enhanced'

const openSurfaces = new Set<LorebookWorkspaceSurface>()
const listeners = new Set<() => void>()

export function setLorebookWorkspaceVisibility(
  surface: LorebookWorkspaceSurface,
  open: boolean,
): void {
  const changed = open ? !openSurfaces.has(surface) : openSurfaces.has(surface)
  if (!changed) return
  if (open) openSurfaces.add(surface)
  else openSurfaces.delete(surface)
  for (const listener of listeners) listener()
}

export function getLorebookWorkspaceOverlayOpen(): boolean {
  return openSurfaces.size > 0
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLorebookWorkspaceOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, getLorebookWorkspaceOverlayOpen, () => false)
}
