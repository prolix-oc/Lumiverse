import { chatsApi, type ChatAppearanceAction, type ChatAppearanceResult } from '@/api/chats'
import { useStore } from '@/store'
import type { Character } from '@/types/api'
import { previewAppearanceMetadata } from './avatarBindings'

const revisions = new Map<string, number>()
const queues = new Map<string, Promise<unknown>>()

export function hasPendingChatAppearance(chatId: string): boolean {
  return queues.has(chatId)
}

/** Optimistically apply an appearance action, serialize writes, and reconcile from the server. */
export function applyChatAppearance(
  chatId: string,
  character: Character,
  action: ChatAppearanceAction,
): Promise<ChatAppearanceResult> {
  // The server resolves the target member from character_id; without it a
  // group action falls back to the chat's primary character and fails when
  // the entry belongs to another member.
  const resolved: ChatAppearanceAction = { ...action, character_id: action.character_id ?? character.id }
  const revision = (revisions.get(chatId) || 0) + 1
  revisions.set(chatId, revision)

  const state = useStore.getState()
  const previousMetadata = state.activeChatMetadata
  const optimisticMetadata = previewAppearanceMetadata(character, previousMetadata, resolved)
  state.setActiveChatMetadata(optimisticMetadata)

  const prior = queues.get(chatId) || Promise.resolve()
  const request = prior.catch(() => undefined).then(() => chatsApi.applyAppearance(chatId, resolved))
  queues.set(chatId, request)

  return request.then((result) => {
    if (revisions.get(chatId) === revision && useStore.getState().activeChatId === chatId) {
      useStore.getState().setActiveChatMetadata(result.chat.metadata || {})
      if (result.greeting_message) {
        useStore.getState().updateMessage(result.greeting_message.id, result.greeting_message)
      }
    }
    return result
  }).catch((error) => {
    if (revisions.get(chatId) === revision && useStore.getState().activeChatId === chatId) {
      useStore.getState().setActiveChatMetadata(previousMetadata)
    }
    throw error
  }).finally(() => {
    if (queues.get(chatId) === request) queues.delete(chatId)
  })
}
