import { useStore } from '@/store'
import type { ConnectionProfile } from '@/types/api'

/** Which binding produced the effective connection; null = just the global active profile. */
export type EffectiveConnectionSource = 'chat' | 'character' | null

export interface EffectiveChatConnection {
  /**
   * The connection generation will actually use for the active chat.
   * Display-level truth: server-only rungs (a committed Edit-and-Send
   * connection, the `editAndSendAlwaysUseActiveConnection` opt-in, and the
   * acting-chain fallback when nothing above resolves) can still differ at
   * generation time.
   */
  effectiveConnectionId: string | null
  /** Which binding (chat pin / character bind) produced the effective id. */
  overrideSource: EffectiveConnectionSource
  /** The chat-pinned connection id, or null when absent/dangling. */
  chatPinnedConnectionId: string | null
  /** The character-bound connection id, or null when absent/dangling/skipped (group chat). */
  characterBoundConnectionId: string | null
  /** The loaded profile for the effective id (null when it is not in the profiles list). */
  profile: ConnectionProfile | null
}

/**
 * Resolve the connection that generation will actually use for the active
 * chat, mirroring the server's ladder (connection-resolution.ts):
 * chat pin > character bind > active profile. A bind naming a connection that
 * is not in the loaded profiles list (deleted elsewhere) degrades to the next
 * rung, and the character bind is skipped in group chats
 * (`metadata.group === true`) because per-member binds would be ambiguous.
 */
export function resolveEffectiveChatConnection(input: {
  profiles: ConnectionProfile[]
  activeProfileId: string | null
  activeChatMetadata: Record<string, any> | null
  activeCharacterConnectionId: string | null
}): EffectiveChatConnection {
  const { profiles, activeProfileId, activeChatMetadata, activeCharacterConnectionId } = input
  const hasProfile = (id: string | null): id is string =>
    typeof id === 'string' && profiles.some((profile) => profile.id === id)

  const chatPinCandidate = typeof activeChatMetadata?.connection_profile_id === 'string'
    ? activeChatMetadata.connection_profile_id
    : null
  const chatPinnedConnectionId = hasProfile(chatPinCandidate) ? chatPinCandidate : null

  const characterBoundConnectionId = activeChatMetadata?.group !== true && hasProfile(activeCharacterConnectionId)
    ? activeCharacterConnectionId
    : null

  const effectiveConnectionId = chatPinnedConnectionId ?? characterBoundConnectionId ?? activeProfileId ?? null
  const overrideSource: EffectiveConnectionSource = chatPinnedConnectionId
    ? 'chat'
    : characterBoundConnectionId
      ? 'character'
      : null

  return {
    effectiveConnectionId,
    overrideSource,
    chatPinnedConnectionId,
    characterBoundConnectionId,
    profile: effectiveConnectionId ? profiles.find((profile) => profile.id === effectiveConnectionId) ?? null : null,
  }
}

/**
 * Store-backed wrapper for the active chat. Components render from this so
 * the picker, the toolbar pill and guided generation all follow the same
 * truth as actual generation.
 */
export function useEffectiveChatConnection(): EffectiveChatConnection {
  const profiles = useStore((s) => s.profiles)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)
  const activeCharacterConnectionId = useStore((s) => s.activeCharacterConnectionId)
  return resolveEffectiveChatConnection({
    profiles,
    activeProfileId,
    activeChatMetadata,
    activeCharacterConnectionId,
  })
}
