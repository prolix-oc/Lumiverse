import type { SpindleConnectionEditorState } from './connection-editor-types'

const DEFAULT_STATE: SpindleConnectionEditorState = {
  profileId: null,
  provider: null,
  isNew: true,
}

let snapshot: SpindleConnectionEditorState = DEFAULT_STATE
const listeners = new Set<(state: SpindleConnectionEditorState) => void>()
const savedListeners = new Set<(profileId: string) => void>()

function cloneState(state: SpindleConnectionEditorState): SpindleConnectionEditorState {
  return {
    profileId: state.profileId,
    provider: state.provider,
    isNew: state.isNew,
  }
}

function projectState(state: SpindleConnectionEditorState): SpindleConnectionEditorState {
  if (state.isNew) return DEFAULT_STATE
  return {
    profileId: typeof state.profileId === 'string' && state.profileId.length > 0
      ? state.profileId
      : null,
    provider: typeof state.provider === 'string' && state.provider.length > 0
      ? state.provider
      : null,
    isNew: false,
  }
}

function sameState(a: SpindleConnectionEditorState, b: SpindleConnectionEditorState): boolean {
  return a.profileId === b.profileId && a.provider === b.provider && a.isNew === b.isNew
}

function publishState(next: SpindleConnectionEditorState): void {
  const projected = projectState(next)
  if (sameState(snapshot, projected)) return
  snapshot = cloneState(projected)
  for (const handler of listeners) {
    try {
      handler(cloneState(snapshot))
    } catch {
      // A single extension must not break the host editor bridge.
    }
  }
}

export function getConnectionEditorState(): SpindleConnectionEditorState {
  return cloneState(snapshot)
}

export function getEditedConnectionProfileId(): string | null {
  return snapshot.profileId
}

export function subscribeConnectionEditorState(
  handler: (state: SpindleConnectionEditorState) => void,
): () => void {
  listeners.add(handler)
  return () => {
    listeners.delete(handler)
  }
}

export function subscribeConnectionEditorSaved(
  handler: (profileId: string) => void,
): () => void {
  savedListeners.add(handler)
  return () => {
    savedListeners.delete(handler)
  }
}

/** Replace the credential-free projection when the native editor identity changes. */
export function syncConnectionEditorState(next: SpindleConnectionEditorState): void {
  publishState(next)
}

/** Reset the shared bridge when the native editor closes or is replaced. */
export function resetConnectionEditorState(): void {
  publishState(DEFAULT_STATE)
}

/** Notify each current subscriber once for one completed native save. */
export function notifyConnectionEditorSaved(profileId: string): void {
  if (profileId.length === 0) return
  for (const handler of [...savedListeners]) {
    try {
      handler(profileId)
    } catch {
      // A single extension must not break the native save flow.
    }
  }
}

// Friendly aliases for host-side callers and focused tests.
export const getState = getConnectionEditorState
export const subscribeState = subscribeConnectionEditorState
export const onSaved = subscribeConnectionEditorSaved
