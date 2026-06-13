import { useEffect } from 'react'
import { useLocation, matchPath } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'

const MAX_CONTEXT_LENGTH = 24

function truncate(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length <= MAX_CONTEXT_LENGTH) return trimmed
  return `${trimmed.slice(0, MAX_CONTEXT_LENGTH).trimEnd()}…`
}

/**
 * Keeps the browser tab title in sync with the current route: the character
 * name (or group chat name) while in a chat, "Home" on the landing page, and
 * the bare app name everywhere else.
 */
export function useDocumentTitle() {
  const { t } = useTranslation(['common', 'landing'])
  const { pathname } = useLocation()
  const routeChatId = matchPath('/chat/:chatId', pathname)?.params.chatId ?? null

  const activeChatId = useStore((s) => s.activeChatId)
  const activeChatName = useStore((s) => s.activeChatName)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const characterName = useStore((s) =>
    s.activeCharacterId
      ? s.characters.find((c) => c.id === s.activeCharacterId)?.name ?? null
      : null
  )

  useEffect(() => {
    const appName = t('common:appName')

    let context: string | null = null
    if (routeChatId) {
      // Store state can still belong to the previous chat while this one loads
      if (activeChatId === routeChatId) {
        // Character-less (temporary) chats have no character name — fall back
        // to the chat's own name.
        context = isGroupChat ? activeChatName || t('landing:groupChat') : characterName || activeChatName
      }
    } else if (pathname === '/') {
      context = t('common:home')
    }

    document.title = context ? `${truncate(context)} · ${appName}` : appName
  }, [routeChatId, pathname, activeChatId, activeChatName, isGroupChat, characterName, t])

  // Restore the default title if the app shell unmounts (e.g. navigating to /login)
  useEffect(() => () => { document.title = 'Lumiverse' }, [])
}
