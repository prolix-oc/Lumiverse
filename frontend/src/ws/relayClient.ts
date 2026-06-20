/**
 * Remote-peer relay client.
 *
 * A remote peer doesn't connect to the host directly — it connects to the
 * Identity Server's relay with a peer token (obtained by redeeming an invite
 * via its own backend). Inbound relay frames carry `{event, payload}` which are
 * dispatched through the EXACT same handler registry as the live socket
 * (wsClient.dispatchExternal), so the whole multiplayer store/UI works
 * unchanged. Outbound room actions are wrapped as relay frames.
 *
 * Resilience (mobile/flaky networks): an app-level heartbeat keeps the NAT
 * mapping warm and detects HALF-OPEN sockets (which never fire `onclose`); on a
 * drop the client auto-reconnects with backoff, minting a FRESH grant via the
 * durable reconnect token (so an expired peer token / membership re-check is
 * handled). A kicked/banned/closed room ends reconnection cleanly.
 */

import { wsClient } from './client'
import { useStore } from '@/store'
import { multiplayerApi } from '@/api/multiplayer'
import { toast } from '@/lib/toast'
import type { JoinGrant, PersonaSnapshot } from '@/types/multiplayer'

const HEARTBEAT_MS = 20_000
const LIVENESS_TIMEOUT_MS = 60_000
const INITIAL_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000
const MAX_RECONNECT_ATTEMPTS = 8
// How long to wait, after announcing `room_join`, for the host's hydration
// (ROOM_STATUS) before declaring the join failed. Catches the silent "connected
// to the relay but never landed in the room" cases (host offline / bridge down,
// silent host-side rejection, dropped/oversized hydration frame).
const JOIN_TIMEOUT_MS = 10_000
// Re-announce room_join this many times on timeout before giving up — covers a
// host whose relay bridge was momentarily down/reconnecting when we first joined
// (our room_join is dropped while no host is attached to the relay).
const MAX_JOIN_ATTEMPTS = 2

let ws: WebSocket | null = null
let joinProfile: { displayName?: string; persona?: PersonaSnapshot | null } = {}
// The durable reconnect token from the active grant, surfaced so the room
// hydration handler can persist it on the shadow chat for later rejoin.
let reconnectToken: string | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let joinTimer: ReturnType<typeof setTimeout> | null = null
let hydrated = false
let joinAttempts = 0
let reconnectMs = INITIAL_RECONNECT_MS
let reconnectAttempts = 0
let lastFrameAt = 0
// Set when the user (or a closed room) intentionally tears down — suppresses
// auto-reconnect so we don't fight a deliberate disconnect.
let intentionalClose = false

function isActive(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function clearJoinTimer(): void {
  if (joinTimer) {
    clearTimeout(joinTimer)
    joinTimer = null
  }
}

/** No hydration arrived after announcing room_join — the join silently failed. */
function onJoinTimeout(): void {
  joinTimer = null
  if (hydrated) return
  // Still connected to the relay but no room state — the host's bridge may have
  // been mid-reconnect when our join landed (room_join is dropped if no host is
  // attached). Re-announce a few times before giving up.
  if (isActive() && joinAttempts < MAX_JOIN_ATTEMPTS) {
    joinAttempts += 1
    sendAction({ type: 'room_join', displayName: joinProfile.displayName, persona: joinProfile.persona })
    joinTimer = setTimeout(onJoinTimeout, JOIN_TIMEOUT_MS)
    return
  }
  if (useStore.getState().mpChatId) {
    // We had been in the room (a reconnect that didn't re-hydrate) — keep retrying.
    dropAndReconnect()
  } else {
    giveUp('Couldn’t reach the host — they may be offline. Try joining again in a moment.')
  }
}

function startHeartbeat(): void {
  stopHeartbeat()
  lastFrameAt = Date.now()
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    // No frame (not even a pong) within the liveness window → the socket is dead
    // (half-open, common on mobile). Drop it and reconnect.
    if (Date.now() - lastFrameAt > LIVENESS_TIMEOUT_MS) {
      dropAndReconnect()
      return
    }
    try {
      ws.send(JSON.stringify({ v: 1, t: 'ctrl', d: { type: 'ping' } }))
    } catch {
      /* socket closing */
    }
  }, HEARTBEAT_MS)
}

function sendAction(action: Record<string, any>): void {
  if (!isActive()) return
  try {
    ws!.send(JSON.stringify({ v: 1, t: 'msg', d: action }))
  } catch {
    /* socket closing */
  }
}

function openSocket(grant: JoinGrant): void {
  if (ws) {
    try {
      ws.close()
    } catch {
      /* noop */
    }
  }
  reconnectToken = grant.reconnectToken ?? reconnectToken
  const url = `${grant.transport.relay.url}?token=${encodeURIComponent(grant.peerToken)}&role=peer`
  const sock = new WebSocket(url)
  ws = sock
  useStore.getState().setRoomConnStatus('connecting')

  sock.onopen = () => {
    if (ws !== sock) return // superseded
    // NB: do NOT reset the reconnect counters here — a socket that opens but
    // never hydrates (host offline / bridge down) must still count as a failed
    // attempt, else it loops forever. They reset on hydration (real success).
    startHeartbeat()
    useStore.getState().setRoomConnStatus('connected')
    // Announce ourselves so the host (re-)materializes our participant + hydrates
    // us. On a reconnect this re-attaches the SAME member → same turn slot.
    sendAction({ type: 'room_join', displayName: joinProfile.displayName, persona: joinProfile.persona })
    // Expect hydration (ROOM_STATUS) shortly — otherwise the join silently failed.
    hydrated = false
    joinAttempts = 0
    clearJoinTimer()
    joinTimer = setTimeout(onJoinTimeout, JOIN_TIMEOUT_MS)
  }

  sock.onmessage = (e) => {
    if (ws !== sock) return
    lastFrameAt = Date.now() // any frame (incl. pong) proves liveness
    let frame: any
    try {
      frame = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
    } catch {
      return
    }
    if (!frame || frame.v !== 1) return
    const d = frame.d
    if (d && typeof d.event === 'string') {
      // Room hydration arrived → the join landed. Cancel the failure timer and
      // reset the reconnect counters (this is the real success signal).
      if (d.event === 'ROOM_STATUS' && d.payload?.room) {
        hydrated = true
        clearJoinTimer()
        reconnectAttempts = 0
        reconnectMs = INITIAL_RECONNECT_MS
      }
      wsClient.dispatchExternal(d.event, d.payload)
    }
  }

  sock.onclose = () => {
    if (ws !== sock) return // stale socket's late close — ignore
    ws = null
    stopHeartbeat()
    clearJoinTimer()
    if (!intentionalClose) scheduleReconnect()
  }
  sock.onerror = () => {
    try {
      sock.close()
    } catch {
      /* noop */
    }
  }
}

/** Drop a (likely half-open) socket and reconnect without waiting on onclose. */
function dropAndReconnect(): void {
  const sock = ws
  ws = null
  stopHeartbeat()
  clearJoinTimer()
  try {
    sock?.close()
  } catch {
    /* already dead */
  }
  scheduleReconnect()
}

function scheduleReconnect(): void {
  if (reconnectTimer || intentionalClose) return
  const s = useStore.getState()
  if (!s.mpRoomId) return // no longer in a room
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    giveUp('Lost connection to the room — open it from your chats to rejoin.')
    return
  }
  s.setRoomConnStatus('connecting')
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void attemptReconnect()
  }, reconnectMs)
  reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS)
}

async function attemptReconnect(): Promise<void> {
  if (intentionalClose) return
  reconnectAttempts += 1
  // The shadow chat id (= host chat id) keys the stored reconnect token.
  const chatId = useStore.getState().mpChatId
  if (!chatId) {
    giveUp('Disconnected from the room.')
    return
  }
  try {
    const grant = await multiplayerApi.reconnect(chatId)
    if (intentionalClose) return
    openSocket(grant)
  } catch (err: any) {
    // Terminal: room closed / kicked / banned / no longer rejoinable → stop.
    const status: number | undefined = err?.status
    if (status === 403 || status === 409 || status === 410) {
      giveUp('The room was closed, or you were removed.')
    } else {
      scheduleReconnect() // transient (network / 5xx) — keep trying with backoff
    }
  }
}

/** Stop reconnecting and clear the room so the chat's Rejoin affordance shows. */
function giveUp(message: string): void {
  intentionalClose = true
  stopHeartbeat()
  clearJoinTimer()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  ws = null
  useStore.getState().clearRoom()
  toast.info(message)
}

export const relayClient = {
  isActive,

  /** The current grant's durable reconnect token, if any. */
  reconnectToken(): string | null {
    return reconnectToken
  },

  connect(grant: JoinGrant, profile: { displayName?: string; persona?: PersonaSnapshot | null } = {}) {
    this.disconnect() // clean slate (sets intentionalClose)
    intentionalClose = false
    joinProfile = profile
    reconnectMs = INITIAL_RECONNECT_MS
    reconnectAttempts = 0
    openSocket(grant)
  },

  /** Send a room action wrapped as a relay frame. */
  send(action: Record<string, any>) {
    sendAction(action)
  },

  disconnect() {
    intentionalClose = true
    stopHeartbeat()
    clearJoinTimer()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
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
