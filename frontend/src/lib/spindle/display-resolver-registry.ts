import type { SpindleDisplayResolver } from 'lumiverse-spindle-types'
import { useStore } from '@/store'

interface RegisteredDisplayResolver {
  identifier: string
  resolver: SpindleDisplayResolver
  skipInlineCardWrapping: boolean
}

let active: RegisteredDisplayResolver | null = null
const listeners = new Set<() => void>()

function notify() { for (const listener of listeners) listener() }

export function subscribeDisplayFormatting(listener: () => void): () => void {
  listeners.add(listener)
  const unsubscribe = useStore.subscribe((state, previous) => {
    if (state.activeChatId !== previous.activeChatId || state.activeChatDisplayOwner !== previous.activeChatDisplayOwner) listener()
  })
  return () => { listeners.delete(listener); unsubscribe() }
}

export function shouldSkipFormattingHealing(chatId?: string): boolean {
  const owner = getDisplayOwnerIdentifier(chatId ?? useStore.getState().activeChatId ?? '')
  return !!owner && active?.identifier === owner && active.resolver.skipFormattingHealing === true
}

export function shouldSkipInlineCardWrapping(chatId?: string): boolean {
  const owner = getDisplayOwnerIdentifier(chatId ?? useStore.getState().activeChatId ?? '')
  return !!owner && active?.identifier === owner && active.skipInlineCardWrapping
}

export function revokeInlineCardWrappingOptOut(identifier: string): void {
  if (active?.identifier === identifier && active.skipInlineCardWrapping) {
    active.skipInlineCardWrapping = false
    notify()
  }
}

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
  const entry: RegisteredDisplayResolver = { identifier, resolver, skipInlineCardWrapping: resolver.skipInlineCardWrapping === true }
  active = entry
  notify()
  return () => {
    if (active === entry) { active = null; notify() }
  }
}

export function unregisterDisplayResolver(identifier: string): void {
  if (active && active.identifier === identifier) { active = null; notify() }
}
