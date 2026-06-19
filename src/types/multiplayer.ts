/** Shared types for the multiplayer rooms feature. A "room" IS the host's chat. */

export type TurnStrategy = "round_robin" | "freeform";
export type RoomStatus = "open" | "locked" | "closed";
export type ParticipantRole = "host" | "peer";
export type IdentityKind = "user" | "token";
export type ParticipantStatus = "active" | "left" | "kicked";

/** Hard ceiling on peers (host excluded). Never exceeded regardless of settings. */
export const HARD_MAX_PEERS = 8;
export const DEFAULT_FREEFORM_WINDOW_SEC = 120;
export const MIN_FREEFORM_WINDOW_SEC = 10;
export const MAX_FREEFORM_WINDOW_SEC = 3600;

/** Max accepted lengths for untrusted peer-supplied fields. */
export const MAX_DISPLAY_NAME_LEN = 64;
export const MAX_PERSONA_NAME_LEN = 64;
export const MAX_PERSONA_DESCRIPTION_LEN = 4000;
export const MAX_ROOM_MESSAGE_BYTES = 16 * 1024; // 16 KB per peer message
export const MAX_AVATAR_URL_LEN = 512;
/** Cap for an embedded `data:` WebP avatar (a small compressed thumbnail). */
export const MAX_AVATAR_DATA_URL_LEN = 24 * 1024;

export interface PersonaPronouns {
  subjective?: string;
  objective?: string;
  possessive?: string;
}

/**
 * A frozen, peer-supplied persona. NEVER a FK into the host's personas/images
 * tables — peers have no rows there. `avatarUrl` is a server-owned URL (the host
 * or Identity Server re-hosts the compressed WebP), never raw peer bytes.
 */
export interface PersonaSnapshot {
  name: string;
  description?: string;
  pronouns?: PersonaPronouns;
  avatarUrl?: string | null;
}

export interface RoomSettings {
  /** Desired peer cap (clamped to HARD_MAX_PEERS). */
  maxPeers: number;
  /** Freeform window length in seconds. */
  freeformWindowSec: number;
}

export interface Room {
  id: string;
  chat_id: string;
  host_user_id: string;
  status: RoomStatus;
  turn_strategy: TurnStrategy;
  freeform_deadline: number | null;
  turn_order: string[];
  current_turn_participant_id: string | null;
  turn_index: number;
  round_counter: number;
  settings: RoomSettings;
  created_at: number;
  updated_at: number;
}

export interface Participant {
  id: string;
  room_id: string;
  role: ParticipantRole;
  identity_kind: IdentityKind;
  identity_ref: string;
  display_name: string;
  persona_snapshot: PersonaSnapshot | null;
  status: ParticipantStatus;
  joined_at: number;
  last_seen: number;
}

/**
 * Participant as seen by OTHER clients in the room. Deliberately omits
 * `identity_kind`/`identity_ref` (which for local accounts is the userId) so a
 * peer cannot learn another participant's underlying account identity.
 */
export interface ParticipantView {
  id: string;
  role: ParticipantRole;
  displayName: string;
  persona: PersonaSnapshot | null;
  status: ParticipantStatus;
  isCurrentTurn: boolean;
}

export interface RoomStateView {
  roomId: string;
  chatId: string;
  status: RoomStatus;
  turnStrategy: TurnStrategy;
  freeformDeadline: number | null;
  currentTurnParticipantId: string | null;
  turnOrder: string[];
  round: number;
  participants: ParticipantView[];
  /** Host-only fields (omitted from peer-facing payloads). */
  hostUserId?: string;
  settings?: RoomSettings;
  /** The viewer's own participant id, when known. */
  selfParticipantId?: string;
}

/** Profile a joiner provides (peer-supplied, validated before storage). */
export interface JoinProfile {
  displayName?: string;
  persona?: PersonaSnapshot | null;
}
