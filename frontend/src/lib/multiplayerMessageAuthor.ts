import type { Message } from '@/types/api'
import type { MessageAuthor, RoomParticipant } from '@/types/multiplayer'

export interface ResolvedMultiplayerMessageAuthor {
  displayName: string
  avatarUrl: string | null
}

function readStampedAuthor(message: Message): MessageAuthor | null {
  if (!message.is_user) return null
  const raw = message.extra?.mp
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const stamp = raw as Partial<MessageAuthor>
  if (typeof stamp.participantId !== 'string' || !stamp.participantId) return null
  if (typeof stamp.displayName !== 'string' || !stamp.displayName) return null

  return {
    participantId: stamp.participantId,
    displayName: stamp.displayName,
    ...(typeof stamp.personaName === 'string' && stamp.personaName
      ? { personaName: stamp.personaName }
      : {}),
    ...(typeof stamp.avatarUrl === 'string' || stamp.avatarUrl === null
      ? { avatarUrl: stamp.avatarUrl ?? null }
      : {}),
  }
}

/**
 * Host-saved `message.extra.mp` is authoritative for peer-authored turns.
 * Live participant state may churn as peers rename/re-avatar, but that must not
 * retroactively rewrite already-saved messages on the host.
 */
export function resolveMultiplayerMessageAuthor(params: {
  message: Message
  roomId: string | null
  participants: RoomParticipant[]
  fallbackDisplayName: string
}): ResolvedMultiplayerMessageAuthor | null {
  const { message, roomId, participants, fallbackDisplayName } = params
  if (!roomId || !message.is_user) return null

  const stamped = readStampedAuthor(message)
  if (stamped) {
    return {
      displayName: stamped.personaName || stamped.displayName || fallbackDisplayName,
      avatarUrl: stamped.avatarUrl ?? null,
    }
  }

  const normalizedName = (message.name || '').trim()
  if (!normalizedName) return null

  // Host/local-account messages in a room have no `extra.mp` stamp, so the
  // live participant roster remains the only available author hint for them.
  const participant = participants.find((p) => p.persona?.name === normalizedName)
  if (!participant) return null

  return {
    displayName: participant.persona?.name || fallbackDisplayName,
    avatarUrl: participant.persona?.avatarUrl ?? null,
  }
}
