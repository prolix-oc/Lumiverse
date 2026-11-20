import type { CreateChatInput, CreateGroupChatInput } from '@/types/api'

export type GreetingChatTarget =
  | { kind: 'solo'; input: CreateChatInput }
  | { kind: 'group'; input: CreateGroupChatInput }

export function shouldStartNewChatForGreeting(totalChatLength: number): boolean {
  return totalChatLength > 1
}

export function buildGreetingChatTarget(options: {
  characterId: string
  greetingIndex: number
  isGroupChat: boolean
  groupCharacterIds: string[]
  greetingCharacterId?: string | null
}): GreetingChatTarget {
  if (options.isGroupChat) {
    return {
      kind: 'group',
      input: {
        character_ids: options.groupCharacterIds,
        greeting_character_id: options.greetingCharacterId || options.characterId,
        greeting_index: options.greetingIndex,
      },
    }
  }

  return {
    kind: 'solo',
    input: {
      character_id: options.characterId,
      greeting_index: options.greetingIndex,
    },
  }
}
