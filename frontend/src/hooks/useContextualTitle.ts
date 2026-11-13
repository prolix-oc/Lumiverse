import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, matchPath } from 'react-router'
import { useStore } from '@/store'

/**
 * Returns the contextual portion of the window/titlebar title:
 * - the character / group chat name while in a chat
 * - "Home" on the landing page
 * - null everywhere else (caller should fall back to the app name)
 *
 * The returned value is stabilized during navigation so that switching from
 * the landing page to a chat does not flash the bare app name while the new
 * chat's state is still loading.
 */
export function useContextualTitle(): string | null {
  const { t } = useTranslation(['common', 'landing'])
  const { pathname } = useLocation()
  const routeChatId = matchPath('/chat/:chatId', pathname)?.params.chatId ?? null

  const activeChatId = useStore((s) => s.activeChatId)
  const activeChatName = useStore((s) => s.activeChatName)
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const landingRecentChats = useStore((s) => s.landingRecentChats)
  const characterName = useStore((s) =>
    s.activeCharacterId
      ? s.characters.find((c) => c.id === s.activeCharacterId)?.name ?? null
      : null
  )

  const previousContextRef = useRef<string | null>(null)

  let nextContext: string | null = null

  if (routeChatId) {
    const recent = landingRecentChats?.data.find(
      (group) => group.latest_chat_id === routeChatId
    )

    // Store state can still belong to the previous chat while this one loads.
    if (activeChatId === routeChatId) {
      // A branch's generated chat-row name can arrive before its character
      // does. Do not expose that implementation label in the window title.
      // The chat name is only authoritative for groups and explicitly
      // character-less temporary chats.
      nextContext = isGroupChat
        ? activeChatName || t('landing:groupChat')
        : characterName
          || recent?.character_name
          || (activeChatMetadata?.temporary === true ? activeChatName : null)
    } else {
      // Try to resolve the name immediately from the landing-page recent chats
      // so the titlebar/tab doesn't flash the bare app name during navigation.
      if (recent) {
        nextContext = recent.is_group
          ? recent.group_name || t('landing:groupChat')
          : recent.character_name
      }
    }
  } else if (pathname === '/') {
    nextContext = t('common:home')
  }

  if (nextContext != null) {
    previousContextRef.current = nextContext
    return nextContext
  }

  // If we are on a chat route whose data hasn't arrived yet, hold the last
  // known context instead of falling back to the app name.
  const isChatLoading = routeChatId != null && activeChatId !== routeChatId
  if (isChatLoading && previousContextRef.current != null) {
    return previousContextRef.current
  }

  return null
}
