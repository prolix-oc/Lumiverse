import type { CharacterPersonaBinding, Persona } from '@/types/api'
import type { PersonaTagBinding } from '@/types/store'
import { resolveAutoPersonaBinding } from '@/store/slices/personas'

export const CHAT_PERSONA_METADATA_KEY = 'active_persona_id'

export type ChatPersonaSource = 'chat' | 'character' | 'tag' | 'default' | 'none'

export interface ResolvedChatPersonaSelection {
  personaId: string | null
  source: ChatPersonaSource
  addonStates?: Record<string, boolean>
  persistedPersonaId: string | null
  persistedPersonaStale: boolean
}

export function getPersistedChatPersonaId(metadata: Record<string, any> | null | undefined): string | null {
  const value = metadata?.[CHAT_PERSONA_METADATA_KEY]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export function setPersistedChatPersonaId(
  metadata: Record<string, any> | null | undefined,
  personaId: string | null,
): Record<string, any> | null {
  const next = { ...(metadata ?? {}) }

  if (personaId) {
    next[CHAT_PERSONA_METADATA_KEY] = personaId
  } else {
    delete next[CHAT_PERSONA_METADATA_KEY]
  }

  return Object.keys(next).length > 0 ? next : null
}

export function resolveChatPersonaSelection(params: {
  metadata: Record<string, any> | null | undefined
  personas: Persona[]
  characterId?: string | null
  characterTags?: string[]
  characterPersonaBindings: Record<string, string | CharacterPersonaBinding>
  personaTagBindings: Record<string, PersonaTagBinding>
}): ResolvedChatPersonaSelection {
  const {
    metadata,
    personas,
    characterId,
    characterTags = [],
    characterPersonaBindings,
    personaTagBindings,
  } = params

  const persistedPersonaId = getPersistedChatPersonaId(metadata)
  if (persistedPersonaId) {
    if (personas.length === 0 || personas.some((persona) => persona.id === persistedPersonaId)) {
      return {
        personaId: persistedPersonaId,
        source: 'chat',
        persistedPersonaId,
        persistedPersonaStale: false,
      }
    }
  }

  const resolvedBinding = resolveAutoPersonaBinding({
    characterId,
    characterTags,
    personas,
    characterPersonaBindings,
    personaTagBindings,
  })

  if (resolvedBinding.personaId) {
    return {
      personaId: resolvedBinding.personaId,
      source: resolvedBinding.source,
      addonStates: resolvedBinding.addonStates,
      persistedPersonaId,
      persistedPersonaStale: !!persistedPersonaId,
    }
  }

  const defaultPersonaId = personas.find((persona) => persona.is_default)?.id ?? null
  if (defaultPersonaId) {
    return {
      personaId: defaultPersonaId,
      source: 'default',
      persistedPersonaId,
      persistedPersonaStale: !!persistedPersonaId,
    }
  }

  return {
    personaId: null,
    source: 'none',
    persistedPersonaId,
    persistedPersonaStale: !!persistedPersonaId,
  }
}
