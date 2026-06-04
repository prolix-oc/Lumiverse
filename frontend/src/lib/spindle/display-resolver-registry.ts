import type { SpindleDisplayResolver } from 'lumiverse-spindle-types'
import { useStore } from '@/store'

interface RegisteredDisplayResolver {
  extensionId: string
  resolver: SpindleDisplayResolver
  ownedCharacterIds: Set<string>
}

let active: RegisteredDisplayResolver | null = null

export function setOwnedDisplayCharacters(extensionId: string, characterIds: string[]): void {
  if (active && active.extensionId === extensionId) {
    active.ownedCharacterIds = new Set(characterIds)
  }
}

export function isDisplayChatOwned(chatId: string): boolean {
  if (!active) return false
  const st = useStore.getState()
  if (chatId !== st.activeChatId) return false
  return st.activeCharacterId != null && active.ownedCharacterIds.has(st.activeCharacterId)
}

export function registerDisplayResolver(
  extensionId: string,
  resolver: SpindleDisplayResolver,
): () => void {
  const entry: RegisteredDisplayResolver = {
    extensionId,
    resolver,
    ownedCharacterIds: active?.extensionId === extensionId ? active.ownedCharacterIds : new Set(),
  }
  active = entry
  return () => {
    if (active === entry) active = null
  }
}

export function unregisterDisplayResolver(extensionId: string): void {
  if (active && active.extensionId === extensionId) active = null
}

export function getActiveDisplayResolver(): SpindleDisplayResolver | null {
  return active ? active.resolver : null
}
