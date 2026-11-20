import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useContextualTitle } from './useContextualTitle'

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
  const { t } = useTranslation('common')
  const context = useContextualTitle()

  useEffect(() => {
    const appName = t('appName')
    document.title = context ? `${truncate(context)} · ${appName}` : appName
  }, [context, t])

  // Restore the default title if the app shell unmounts (e.g. navigating to /login)
  useEffect(() => () => { document.title = 'Lumiverse' }, [])
}
