import { hasTauriDesktopBridge } from '@/lib/desktopWebView'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type DesktopPresenceState = 'hidden' | 'minimized' | 'background' | 'foreground'

/** Native window state for the primary Tauri frontend. */
export interface DesktopPresence {
  state: DesktopPresenceState
  visible: boolean
  minimized: boolean
  focused: boolean
  active: boolean
}

let currentPresence: DesktopPresence | null = null

function isDesktopPresence(value: unknown): value is DesktopPresence {
  if (!value || typeof value !== 'object') return false
  const presence = value as Partial<DesktopPresence>
  return (
    ['hidden', 'minimized', 'background', 'foreground'].includes(presence.state ?? '')
    && typeof presence.visible === 'boolean'
    && typeof presence.minimized === 'boolean'
    && typeof presence.focused === 'boolean'
    && typeof presence.active === 'boolean'
  )
}

export function isTauriDesktopPresenceAvailable(): boolean {
  return hasTauriDesktopBridge()
}

export function getDesktopPresence(): DesktopPresence | null {
  return currentPresence
}

function publishPresence(value: unknown, onChange: (presence: DesktopPresence) => void) {
  if (!isDesktopPresence(value)) return
  currentPresence = value
  onChange(value)
}

/**
 * Subscribe to native window transitions and then fetch a snapshot. Listening
 * first closes the startup race where the window changes while IPC initializes.
 */
export async function subscribeDesktopPresence(
  onChange: (presence: DesktopPresence) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktopPresenceAvailable()) return () => {}

  const unlisten = await listen<DesktopPresence>('desktop-presence-changed', ({ payload }) => {
    publishPresence(payload, onChange)
  })

  try {
    const snapshot = await invoke<DesktopPresence | null>('frontend_presence')
    publishPresence(snapshot, onChange)
  } catch (error) {
    console.warn('[desktop-presence] Could not read native window state', error)
  }

  return unlisten
}
