/**
 * Resolves the voice for each piece of TTS playback.
 *
 * Two responsibilities:
 *   - `resolveMessageSpeaker` — figure out WHO is speaking for a given message
 *     (group chats don't carry character_id on messages, so the speaker is
 *     inferred from message.name + is_user against the chat's member list).
 *   - `resolveSegmentVoice` — given a parsed segment + the resolved speaker,
 *     return the VoiceRef to synthesize with, walking the documented fallback
 *     order (chat override → character default → global default).
 *
 * Both are pure functions — easy to call from playback hooks and to unit test.
 */

import type { TextSegment, SegmentAction } from '@/lib/speechDetection'
import type { Character, Message, VoiceRef, GroupChatMetadata } from '@/types/api'
import type { VoiceSettings } from '@/types/store'

export interface ResolvedSpeaker {
  /** The character.id of the speaker, or null for user messages / unknown speakers. */
  characterId: string | null
  /** True when the message is from the user (persona) rather than a character. */
  isUser: boolean
}

export interface ResolveSpeakerInput {
  message: Pick<Message, 'name' | 'is_user'>
  /** Characters loaded into the store — used to resolve name → id. */
  characters: Pick<Character, 'id' | 'name'>[]
  /**
   * Group member ids, when the chat is a group chat. Narrows the search so a
   * name collision with a non-member character can't steal the speaker slot.
   * Pass `null` for single-character chats.
   */
  groupMemberIds: string[] | null
  /**
   * Fallback for single-character chats: the chat's owning character_id.
   * Used when the message name didn't match anything (rare — usually because
   * the card was renamed after the message was written).
   */
  fallbackCharacterId: string | null
}

/**
 * Resolves the speaker for a message. Returns `characterId: null` for user
 * messages or when no member matches. Match is case-insensitive on `name` to
 * tolerate cosmetic case changes between card edits.
 */
export function resolveMessageSpeaker({
  message,
  characters,
  groupMemberIds,
  fallbackCharacterId,
}: ResolveSpeakerInput): ResolvedSpeaker {
  if (message.is_user) {
    return { characterId: null, isUser: true }
  }

  const target = message.name?.trim().toLowerCase() ?? ''
  if (target) {
    const memberSet = groupMemberIds ? new Set(groupMemberIds) : null
    for (const c of characters) {
      if (memberSet && !memberSet.has(c.id)) continue
      if (c.name.trim().toLowerCase() === target) {
        return { characterId: c.id, isUser: false }
      }
    }
  }

  return { characterId: fallbackCharacterId, isUser: false }
}

export interface ResolveVoiceInput {
  segment: TextSegment
  speaker: ResolvedSpeaker
  /** The character record for the resolved speaker, if available. */
  character: Pick<Character, 'extensions'> | null
  /** Chat metadata for the active chat. May be a group chat or a single-char chat. */
  chatMetadata: Record<string, any> | null
  voiceSettings: VoiceSettings
}

/**
 * The final voice for a segment, plus the action that classified it. Action
 * may be `'skip'` — callers must drop those before synthesizing.
 */
export interface ResolvedVoice {
  voice: VoiceRef | null
  action: SegmentAction
}

/**
 * Read a VoiceRef out of an unknown JSON blob. Returns null if the shape is
 * wrong — we trust nothing from `extensions` or `metadata` since both are
 * free-form.
 */
function readVoiceRef(value: unknown): VoiceRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.connectionId !== 'string' || !v.connectionId) return null
  const voice = typeof v.voice === 'string' ? v.voice : ''
  const parameters =
    v.parameters && typeof v.parameters === 'object'
      ? { speed: typeof (v.parameters as any).speed === 'number' ? (v.parameters as any).speed : undefined }
      : undefined
  return { connectionId: v.connectionId, voice, parameters }
}

function readGroupVoiceOverrides(
  chatMetadata: Record<string, any> | null,
): GroupChatMetadata['voiceOverrides'] | null {
  if (!chatMetadata || typeof chatMetadata !== 'object') return null
  const overrides = chatMetadata.voiceOverrides
  if (!overrides || typeof overrides !== 'object') return null
  return overrides
}

function characterVoice(character: ResolveVoiceInput['character']): VoiceRef | null {
  if (!character?.extensions) return null
  return readVoiceRef(character.extensions.ttsVoice)
}

function globalSpeechVoice(voiceSettings: VoiceSettings): VoiceRef | null {
  if (!voiceSettings.ttsConnectionId) return null
  return {
    connectionId: voiceSettings.ttsConnectionId,
    voice: '',
  }
}

/**
 * Resolve the VoiceRef for one parsed segment.
 *
 * Fallback chain:
 *   - segment.action === 'skip'         → no voice (caller drops it)
 *   - 'narration'                        → chat narrator override
 *                                         → global narrationVoice
 *                                         → resolved speech voice (so we
 *                                           never accidentally muffle a
 *                                           narration-only message)
 *   - 'speech'                           → chat character override
 *                                         → character.extensions.ttsVoice
 *                                         → global ttsConnectionId
 */
export function resolveSegmentVoice({
  segment,
  speaker,
  character,
  chatMetadata,
  voiceSettings,
}: ResolveVoiceInput): ResolvedVoice {
  const action = segment.action
  if (action === 'skip') {
    return { voice: null, action }
  }

  const overrides = readGroupVoiceOverrides(chatMetadata)
  const chatNarrator = readVoiceRef(overrides?.narrator)
  const chatCharOverride =
    speaker.characterId && overrides?.characters
      ? readVoiceRef(overrides.characters[speaker.characterId])
      : null

  const speech =
    chatCharOverride
    ?? characterVoice(character)
    ?? globalSpeechVoice(voiceSettings)

  // Thoughts belong to the character — read in their own speech voice. The
  // action tag is preserved so future UX (e.g. a dedicated thought voice or
  // a thought-specific filter pipeline) can branch on it without reclassifying.
  if (action === 'speech' || action === 'thought') {
    return { voice: speech, action }
  }

  // narration
  const narrator = chatNarrator ?? voiceSettings.narrationVoice ?? speech
  return { voice: narrator, action }
}

/**
 * Stable key for grouping segments that resolve to the same voice. Used by
 * the playback hook to coalesce adjacent same-voice segments into one TTS
 * request (fewer calls, fewer audio joins).
 */
export function voiceCoalesceKey(voice: VoiceRef | null): string {
  if (!voice) return 'skip'
  const speed = voice.parameters?.speed
  return `${voice.connectionId}|${voice.voice}|${speed ?? ''}`
}
