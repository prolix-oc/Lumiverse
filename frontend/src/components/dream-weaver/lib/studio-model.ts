import type { DreamWeaverDraft, DreamWeaverSession } from '@/api/dream-weaver'

export const MAIN_TABS = ['soul', 'world', 'visuals'] as const
export const SOUL_SECTIONS = [
  'name',
  'appearance',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'voice_guidance',
  'alternate_fields',
  'greetings',
  'system_prompt',
  'post_history_instructions',
] as const
export const WORLD_SECTIONS = ['lorebooks', 'npc_definitions', 'regex_scripts'] as const
export const VISUALS_SECTIONS = [] as const

export function hasWorldContent(draft: DreamWeaverDraft | null): boolean {
  if (!draft) return false
  return (
    (draft.lorebooks?.length ?? 0) > 0 ||
    (draft.npc_definitions?.length ?? 0) > 0 ||
    (draft.regex_scripts?.length ?? 0) > 0
  )
}

export function getTextSectionStatus(value: string | null | undefined): 'empty' | 'populated' {
  return value?.trim() ? 'populated' : 'empty'
}

export function resolveSelectedConnectionId(
  sessionConnectionId: string | null | undefined,
  connections: Array<{ id: string; is_default?: boolean | null }>,
): string | null {
  if (sessionConnectionId && connections.some((connection) => connection.id === sessionConnectionId)) {
    return sessionConnectionId
  }

  const defaultConnection = connections.find((connection) => connection.is_default)
  return defaultConnection?.id ?? connections[0]?.id ?? null
}

export function canFinalize(session: DreamWeaverSession | null, draft: DreamWeaverDraft | null): boolean {
  if (!session || !draft) return false

  return session.soul_state === 'ready' && !session.character_id && Boolean(
    draft.card.name.trim() &&
    draft.card.description.trim() &&
    draft.card.personality.trim() &&
    draft.card.scenario.trim() &&
    draft.card.first_mes.trim()
  )
}

export function shouldOfferOpenChat(session: DreamWeaverSession | null): boolean {
  return Boolean(session?.character_id)
}

export function getSessionStatusLabel(session: DreamWeaverSession): string {
  if (session.character_id) return 'Finalized'
  if (session.soul_state === 'ready' && session.world_state === 'stale') {
    return 'Soul ready (world check recommended)'
  }
  if (session.soul_state === 'ready') return 'Soul ready'
  if (session.soul_state === 'generating') return 'Weaving'
  if (session.soul_state === 'error') return 'Needs attention'
  return 'Saved'
}

export function isWorldStale(session: DreamWeaverSession | null): boolean {
  return session?.world_state === 'stale'
}

export const WEAVING_OPERATIONS = {
  soul: {
    title: 'Weaving The Soul',
    description: 'Shaping the card, voice, and opening from your dream.',
    steps: ['Reading dream', 'Shaping voice', 'Binding the card'],
  },
  world: {
    title: 'Building The World',
    description: 'Generating lorebooks, NPC definitions, and regex scripts from the soul.',
    steps: ['Preparing world', 'Building world', 'Assembling lorebooks & NPCs', 'Saving world data'],
  },
  finalize: {
    title: 'Bringing To Life',
    description: 'Creating your character and preparing the first chat.',
    steps: ['Saving portrait', 'Creating character', 'Setting up chat', 'Finishing up'],
  },
} as const
