/**
 * Remote-peer relay client.
 *
 * A remote peer doesn't connect to the host directly — it connects to the
 * Identity Server's relay with a peer token (obtained by redeeming an invite
 * via its own backend). Inbound relay frames carry `{event, payload}` which are
 * dispatched through the EXACT same handler registry as the live socket
 * (wsClient.dispatchExternal), so the whole multiplayer store/UI works
 * unchanged. Outbound room actions are wrapped as relay frames.
 */

import { wsClient } from './client'
import { useStore } from '@/store'
import type { JoinGrant, PersonaSnapshot } from '@/types/multiplayer'

let ws: WebSocket | null = null
let joinProfile: { displayName?: string; persona?: PersonaSnapshot | null } = {}
// The durable reconnect token from the active grant, surfaced so the room
// hydration handler can persist it on the shadow chat for later rejoin.
let reconnectToken: string | null = null

function isActive(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN
}

export const relayClient = {
  isActive,

  /** The current grant's durable reconnect token, if any. */
  reconnectToken(): string | null {
    return reconnectToken
  },

  connect(grant: JoinGrant, profile: { displayName?: string; persona?: PersonaSnapshot | null } = {}) {
    this.disconnect()
    joinProfile = profile
    reconnectToken = grant.reconnectToken ?? null
    const url = `${grant.transport.relay.url}?token=${encodeURIComponent(grant.peerToken)}&role=peer`
    const sock = new WebSocket(url)
    ws = sock
    useStore.getState().setRoomConnStatus('connecting')

    sock.onopen = () => {
      useStore.getState().setRoomConnStatus('connected')
      // Announce ourselves so the host materializes a participant + hydrates us.
      this.send({ type: 'room_join', displayName: joinProfile.displayName, persona: joinProfile.persona })
    }

    sock.onmessage = (e) => {
      let frame: any
      try {
        frame = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
      } catch {
        return
      }
      if (!frame || frame.v !== 1) return
      const d = frame.d
      if (d && typeof d.event === 'string') {
        wsClient.dispatchExternal(d.event, d.payload)
      }
    }

    sock.onclose = () => {
      if (ws === sock) {
        ws = null
        const s = useStore.getState()
        // Only surface 'closed' if we still think we're in this room.
        if (s.mpRoomId) s.setRoomConnStatus('closed')
      }
    }
    sock.onerror = () => {
      try {
        sock.close()
      } catch {
        /* noop */
      }
    }
  },

  /** Send a room action wrapped as a relay frame. */
  send(action: Record<string, any>) {
    if (!isActive()) return
    try {
      ws!.send(JSON.stringify({ v: 1, t: 'msg', d: action }))
    } catch {
      /* socket closing */
    }
  },

  disconnect() {
    if (ws) {
      try {
        ws.close()
      } catch {
        /* noop */
      }
      ws = null
    }
  },
}

/**
 * Route a room action over the active transport: the relay (remote peer) when
 * connected, otherwise the host's own socket (local/LAN peer + host).
 */
export function sendRoomAction(action: Record<string, any>): void {
  if (relayClient.isActive()) relayClient.send(action)
  else wsClient.send(action)
}
