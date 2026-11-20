import { invoke } from '@tauri-apps/api/core'
import { isTauriDesktopPresenceAvailable } from './desktop-presence'
import { EventType } from '@/types/ws-events'

interface PresenceEvents {
  on(event: string, handler: (payload?: { role?: unknown }) => void): () => void
}

/** Refresh on authenticated startup/reconnect and committed navigation or library changes. */
export function subscribeDesktopDiscordPresenceRefresh(events: PresenceEvents): () => void {
  if (!isTauriDesktopPresenceAvailable()) return () => {}

  const refresh = () => {
    void invoke('discord_presence_changed').catch((error) => {
      console.warn('[discord-presence] Could not refresh desktop presence', error)
    })
  }
  const unsubs = [
    EventType.CHAT_SWITCHED,
    EventType.CHARACTER_CREATED,
    EventType.CHARACTER_DELETED,
    EventType.CHARACTER_LIBRARY_CHANGED,
  ].map((event) => events.on(event, refresh))
  unsubs.push(events.on(EventType.CONNECTED, (payload) => {
    // CONNECTED is also emitted locally at socket-open with an empty payload.
    // The server's role-bearing acknowledgement means authentication is ready.
    if (typeof payload?.role === 'string' && payload.role.length > 0) refresh()
  }))
  return () => { unsubs.forEach((unsubscribe) => unsubscribe()) }
}
