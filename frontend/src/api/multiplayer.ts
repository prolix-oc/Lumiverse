import { get, post, patch } from './client'
import type { RoomStateView, TurnStrategy, JoinGrant } from '@/types/multiplayer'

export interface CreateRoomInput {
  chat_id: string
  turn_strategy?: TurnStrategy
  settings?: { maxPeers?: number; freeformWindowSec?: number }
}

export interface InviteResult {
  token: string
  roomId: string
  expiresAt: number
}

export const multiplayerApi = {
  create(input: CreateRoomInput) {
    return post<RoomStateView>('/multiplayer/rooms', input)
  },
  get(roomId: string) {
    return get<RoomStateView>(`/multiplayer/rooms/${roomId}`)
  },
  byChat(chatId: string) {
    return get<{ room: RoomStateView | null }>(`/multiplayer/rooms/by-chat/${chatId}`)
  },
  update(roomId: string, patchBody: { status?: string; turn_strategy?: TurnStrategy; settings?: object }) {
    return patch<RoomStateView>(`/multiplayer/rooms/${roomId}`, patchBody)
  },
  close(roomId: string) {
    return post<{ ok: boolean }>(`/multiplayer/rooms/${roomId}/close`)
  },
  invite(roomId: string) {
    return post<InviteResult>(`/multiplayer/rooms/${roomId}/invite`)
  },

  // ── Remote multiplayer (Identity Server) ──
  enableRemote(roomId: string) {
    return post<{ ok: boolean; server: string }>(`/multiplayer/rooms/${roomId}/remote/enable`)
  },
  remoteInvite(roomId: string) {
    return post<{ code: string; expiresAt: number; server: string }>(`/multiplayer/rooms/${roomId}/remote/invite`)
  },
  disableRemote(roomId: string) {
    return post<{ ok: boolean }>(`/multiplayer/rooms/${roomId}/remote/disable`)
  },
  /** Peer side: redeem an invite code → JoinGrant (relay URL + peer token). */
  joinByCode(code: string, displayName?: string) {
    return post<JoinGrant>('/multiplayer/join', { code, displayName })
  },
  /** Peer side: rejoin a previously-joined remote room from history (no new code). */
  reconnect(chatId: string) {
    return post<JoinGrant>('/multiplayer/reconnect', { chatId })
  },
  /** Peer side: record a joined room as a local chat in the user's history. */
  saveShadow(input: {
    chatId: string
    roomId: string
    name?: string
    characterName?: string
    messages?: unknown[]
    reconnectToken?: string
  }) {
    return post<{ ok: boolean }>('/multiplayer/shadow', input)
  },

  // Host turn controls (REST-primary; the server broadcasts the resulting events).
  promote(roomId: string, participantId: string) {
    return post<{ ok: boolean }>(`/multiplayer/rooms/${roomId}/turn/promote`, { participant_id: participantId })
  },
  skip(roomId: string, participantId: string) {
    return post<{ ok: boolean }>(`/multiplayer/rooms/${roomId}/turn/skip`, { participant_id: participantId })
  },
  kick(roomId: string, participantId: string) {
    return post<{ ok: boolean }>(`/multiplayer/rooms/${roomId}/participants/${participantId}/kick`)
  },
  ban(roomId: string, participantId: string, reason?: string) {
    return post<{ ok: boolean }>(`/multiplayer/rooms/${roomId}/participants/${participantId}/ban`, { reason })
  },

  // Freeform window controls.
  startFreeform(roomId: string) {
    return post<{ ok: boolean; deadline: number | null }>(`/multiplayer/rooms/${roomId}/freeform/start`)
  },
  endFreeform(roomId: string) {
    return post<{ ok: boolean }>(`/multiplayer/rooms/${roomId}/freeform/end`)
  },
}
