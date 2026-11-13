import i18n from '@/i18n'
import { charactersApi } from '@/api/characters'
import { chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import { toast } from '@/lib/toast'
import type { Character, CharacterSummary } from '@/types/api'

function showChatCreationToast() {
  return toast.info(i18n.t('chat.toast.creatingChatCortex'), {
    title: i18n.t('chat.toast.startingChat'),
    duration: 60_000,
    dismissible: false,
  })
}

/**
 * Start a new chat with a character and open it. A character with alternate
 * greetings opens the greeting picker first. Rejects when the chat cannot be
 * created; the greeting picker reports its own errors.
 */
export async function startCharacterChat(
  character: Character | CharacterSummary,
  navigate: (path: string) => void,
): Promise<void> {
  const hasAlternates = 'has_alternate_greetings' in character
    ? character.has_alternate_greetings
    : (character as Character).alternate_greetings?.length > 0

  if (hasAlternates) {
    const fullChar = await charactersApi.get(character.id)
    useStore.getState().openModal('greetingPicker', {
      character: fullChar,
      onSelect: async (greetingIndex: number) => {
        const toastId = showChatCreationToast()
        try {
          const chat = await chatsApi.create({
            character_id: character.id,
            greeting_index: greetingIndex,
          })
          toast.dismiss(toastId)
          navigate(`/chat/${chat.id}`)
        } catch (err) {
          toast.dismiss(toastId)
          console.error('[CharacterBrowser] Failed to create chat:', err)
          toast.error(i18n.t('chat.toast.failedCreateChat'))
        }
      },
    })
    return
  }

  const toastId = showChatCreationToast()
  let chatId: string
  try {
    chatId = (await chatsApi.create({ character_id: character.id })).id
  } finally {
    toast.dismiss(toastId)
  }
  navigate(`/chat/${chatId}`)
}

/**
 * Open a character's most recently updated chat, or start a new one when the
 * character has no chat yet or `mode` is `'new'`.
 */
export async function openCharacterChat(
  characterId: string,
  mode: 'latest' | 'new',
  navigate: (path: string) => void,
): Promise<void> {
  const character = await charactersApi.get(characterId)
  if (mode === 'latest') {
    // The server lists a character's chats by updated_at, newest first.
    const [latest] = await chatsApi.listCharacterChats(character.id)
    if (latest) {
      navigate(`/chat/${latest.id}`)
      return
    }
  }
  await startCharacterChat(character, navigate)
}
