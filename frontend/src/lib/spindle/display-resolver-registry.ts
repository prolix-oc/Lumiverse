import type { SpindleDisplayResolver } from 'lumiverse-spindle-types'
import { useStore } from '@/store'

interface RegisteredDisplayResolver {
  identifier: string
  resolver: SpindleDisplayResolver
}

let active: RegisteredDisplayResolver | null = null

export function getDisplayOwnerIdentifier(chatId: string): string | null {
  const st = useStore.getState()
  if (chatId !== st.activeChatId) return null
  const owner = st.activeChatDisplayOwner
  return typeof owner === 'string' && owner.length > 0 ? owner : null
}

export function isDisplayChatOwned(chatId: string): boolean {
  return getDisplayOwnerIdentifier(chatId) !== null
}

export function getDisplayResolverForChat(chatId: string): SpindleDisplayResolver | null {
  const owner = getDisplayOwnerIdentifier(chatId)
  if (!owner || !active || active.identifier !== owner) return null
  if (!active.resolver.ready(chatId)) return null
  return active.resolver
}

export function registerDisplayResolver(
  identifier: string,
  resolver: SpindleDisplayResolver,
): () => void {
  const entry: RegisteredDisplayResolver = { identifier, resolver }
  active = entry
  return () => {
    if (active === entry) active = null
  }
}

export function unregisterDisplayResolver(identifier: string): void {
  if (active && active.identifier === identifier) active = null
}
