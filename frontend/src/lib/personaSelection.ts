import i18n from '@/i18n'
import { chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import { personaToastName } from '@/store/slices/personas'
import {
  CHAT_PERSONA_METADATA_KEY,
  getPersistedChatPersonaId,
  resolveChatPersonaSelection,
  setPersistedChatPersonaId,
} from '@/lib/chatPersonaSelection'
import { toast } from '@/lib/toast'

const tp = (key: string, options?: Record<string, unknown>) =>
  i18n.t(`personaManager.toast.${key}`, { ns: 'panels', ...options })

let latestSelection = 0

/**
 * Make a persona active, or deactivate the current one with `null`. In a saved
 * chat the choice is stored on the chat, so it applies to that chat only.
 */
export async function selectPersona(personaId: string | null): Promise<void> {
  const selection = ++latestSelection
  const state = useStore.getState()
  const chatId = state.activeChatId
  const announce = () => {
    if (personaId === null) {
      toast.info(tp('personaDeactivated'))
      return
    }
    const persona = state.personas.find((p) => p.id === personaId)
    if (persona) toast.info(tp('switchedToPersona', { name: personaToastName(persona) }))
  }

  const isChatScoped = !!chatId && state.activeChatMetadata?.temporary !== true
  if (!isChatScoped) {
    state.setActivePersona(personaId)
    announce()
    return
  }

  const activeCharacter = state.activeCharacterId
    ? state.characters.find((character) => character.id === state.activeCharacterId) ?? null
    : null
  const previousMetadata = state.activeChatMetadata
  const previousActivePersonaId = state.activePersonaId
  const nextMetadata = setPersistedChatPersonaId(previousMetadata, personaId)
  const fallbackPersonaId = personaId ?? resolveChatPersonaSelection({
    metadata: nextMetadata,
    characterId: state.activeCharacterId,
    characterTags: activeCharacter?.tags ?? [],
    personas: state.personas,
    characterPersonaBindings: state.characterPersonaBindings,
    personaTagBindings: state.personaTagBindings,
  }).personaId

  state.setActiveChatMetadata(nextMetadata)
  state.setActivePersona(fallbackPersonaId)

  try {
    await chatsApi.patchMetadata(chatId!, { [CHAT_PERSONA_METADATA_KEY]: personaId })
    if (selection === latestSelection && useStore.getState().activeChatId === chatId) announce()
  } catch (err) {
    console.error('[PersonaBrowser] Failed to save chat persona selection:', err)
    const current = useStore.getState()
    // A late failure must not restore another chat or discard metadata edits
    // made while this request was saving.
    if (selection === latestSelection && current.activeChatId === chatId
      && getPersistedChatPersonaId(current.activeChatMetadata) === personaId) {
      current.setActiveChatMetadata(setPersistedChatPersonaId(current.activeChatMetadata, getPersistedChatPersonaId(previousMetadata)))
      if (current.activePersonaId === fallbackPersonaId) current.setActivePersona(previousActivePersonaId)
    }
    toast.error(tp('failedSaveChatPersona'))
    throw err
  }
}
