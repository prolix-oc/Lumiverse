/** Frontend mirror of the backend multiplayer payload shapes. */

export type TurnStrategy = 'round_robin' | 'freeform'
export type RoomStatus = 'open' | 'locked' | 'closed'
export type ParticipantRole = 'host' | 'peer'
export type ParticipantStatus = 'active' | 'left' | 'kicked'
export type RoomConnStatus = 'idle' | 'connecting' | 'connected' | 'closed'

export interface PersonaSnapshot {
  name: string
  description?: string
  pronouns?: { subjective?: string; objective?: string; possessive?: string }
  /** Server-owned URL of the broadcast WebP avatar (never a raw peer URL). */
  avatarUrl?: string | null
}

export interface RoomParticipant {
  id: string
  role: ParticipantRole
  displayName: string
  persona: PersonaSnapshot | null
  status: ParticipantStatus
  isCurrentTurn: boolean
  /** Client-only ephemeral presence. */
  typing?: boolean
}

export interface RoomStateView {
  roomId: string
  chatId: string
  status: RoomStatus
  turnStrategy: TurnStrategy
  /** Unix seconds; null unless a freeform window is open. */
  freeformDeadline: number | null
  currentTurnParticipantId: string | null
  turnOrder: string[]
  round: number
  participants: RoomParticipant[]
  /** Host-only fields. */
  hostUserId?: string
  settings?: { maxPeers: number; freeformWindowSec: number }
  /** The viewer's own participant id, when known. */
  selfParticipantId?: string
}

/** Returned by the peer-join proxy; the frontend uses it to connect to the relay. */
export interface JoinGrant {
  roomId: string
  memberId: string
  peerToken: string
  /** Durable, revocable credential to rejoin later without a fresh invite code. */
  reconnectToken?: string
  transport: {
    relay: { url: string; expiresAt: number }
    direct?: { url: string; directToken: string; expiresAt: number }
  }
}

/** Author attribution stamped on peer-authored messages (rides in message.extra). */
export interface MessageAuthor {
  participantId: string
  displayName: string
  personaName?: string
  /** Small relayed data URL, persisted so message avatars survive room teardown. */
  avatarUrl?: string | null
}
