/** Host-owned approval, local to this origin, account and installed extension. */
export interface SystemAudioConsent {
  readonly remembered: boolean
  readonly paused: boolean
}

type Change = 'remember' | 'pause' | 'resume' | 'revoke' | 'clear' | 'external'
type Listener = (consent: SystemAudioConsent, change: Change, previous: SystemAudioConsent) => void
type ConsentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const PREFIX = 'lumiverse:system-audio-consent:v1:'
const ASK: SystemAudioConsent = Object.freeze({ remembered: false, paused: false })

function decode(raw: string | null): SystemAudioConsent {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (value && typeof value.remembered === 'boolean' && typeof value.paused === 'boolean') {
      return Object.freeze({ remembered: value.remembered, paused: value.paused })
    }
  } catch { /* A malformed entry never grants approval. */ }
  return ASK
}

export function createSystemAudioConsentStore(storage: () => ConsentStorage | null) {
  const records = new Map<string, SystemAudioConsent>()
  const listeners = new Map<string, Set<Listener>>()
  const key = (userId: string | null, extensionId: string) =>
    `${PREFIX}${JSON.stringify([userId, extensionId])}`

  const read = (userId: string | null, extensionId: string): SystemAudioConsent => {
    const id = key(userId, extensionId)
    if (!records.has(id)) {
      let value = ASK
      if (userId) {
        try { value = decode(storage()?.getItem(id) ?? null) } catch { /* Ask when storage is unavailable. */ }
      }
      records.set(id, value)
    }
    return records.get(id)!
  }

  const notify = (id: string, next: SystemAudioConsent, change: Change) => {
    const previous = records.get(id) ?? ASK
    if (previous.remembered === next.remembered && previous.paused === next.paused) return
    records.set(id, Object.freeze(next))
    for (const listener of [...(listeners.get(id) ?? [])]) listener(records.get(id)!, change, previous)
  }

  const write = (userId: string | null, extensionId: string, next: SystemAudioConsent, change: Change): boolean => {
    read(userId, extensionId)
    const id = key(userId, extensionId)
    let target: ConsentStorage | null = null
    try {
      target = userId ? storage() : null
      if (change === 'remember' && !target) return false
      if (target) {
        if (!next.remembered && !next.paused) target.removeItem(id)
        else target.setItem(id, JSON.stringify(next))
      }
    } catch {
      // A failed save cannot create a remembered grant. Stop and revocation still take effect in memory.
      if (change === 'remember') return false
      // Quota failures can still allow removal: do not leave an old approval available after a reload.
      try { target?.removeItem(id) } catch { /* The local stop remains in effect even if storage is blocked. */ }
    }
    notify(id, next, change)
    return true
  }

  return {
    read,
    remember(userId: string | null, extensionId: string) {
      return write(userId, extensionId, { remembered: true, paused: false }, 'remember')
    },
    pause(userId: string | null, extensionId: string) {
      write(userId, extensionId, { ...read(userId, extensionId), paused: true }, 'pause')
    },
    resume(userId: string | null, extensionId: string) {
      write(userId, extensionId, { ...read(userId, extensionId), paused: false }, 'resume')
    },
    revoke(userId: string | null, extensionId: string) {
      write(userId, extensionId, { remembered: false, paused: true }, 'revoke')
    },
    clear(userId: string | null, extensionId: string) {
      write(userId, extensionId, ASK, 'clear')
    },
    /** Permission events must forget approval even when the extension has no loaded frontend. */
    permissionsChanged(userId: string | null, payload: unknown) {
      if (!userId || typeof payload !== 'object' || payload === null) return
      if (!('extensionId' in payload) || typeof payload.extensionId !== 'string' || !('allGranted' in payload)) return
      if (!Array.isArray(payload.allGranted) || !payload.allGranted.every(permission => typeof permission === 'string')) return
      if (!payload.allGranted.includes('system_audio')) write(userId, payload.extensionId, ASK, 'clear')
    },
    subscribe(userId: string | null, extensionId: string, listener: Listener) {
      read(userId, extensionId)
      const id = key(userId, extensionId)
      const set = listeners.get(id) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(id, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(id)
      }
    },
    /** Storage events also apply Stop or revocation to an already running client on this origin. */
    refresh(storageKey: string | null) {
      for (const id of records.keys()) {
        if (storageKey !== null && id !== storageKey) continue
        try { notify(id, decode(storage()?.getItem(id) ?? null), 'external') } catch { /* Keep local stops. */ }
      }
    },
  }
}

export const systemAudioConsent = createSystemAudioConsentStore(() =>
  typeof window === 'undefined' ? null : window.localStorage,
)

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key.startsWith(PREFIX)) systemAudioConsent.refresh(event.key)
  })
}
