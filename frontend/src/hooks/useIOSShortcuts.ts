import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useStore } from '@/store'
import { hasIOSNativeBridge } from '@/lib/ios-native'
import { installIOSShortcuts, lastIOSChat, rememberIOSChat } from '@/lib/ios-shortcuts'

export function useIOSShortcuts() {
  const navigate = useNavigate()
  const accountId = useStore(s => s.isAuthenticated ? s.user?.id ?? null : null)
  const ready = useStore(s => s.settingsLoaded)
  const chatId = useStore(s => s.activeChatId)

  useEffect(() => {
    if (accountId && ready && hasIOSNativeBridge()) rememberIOSChat(accountId, chatId)
  }, [accountId, ready, chatId])

  useEffect(() => {
    if (!accountId || !ready) return
    return installIOSShortcuts(action => {
      const state = useStore.getState()
      if (!state.isAuthenticated || state.user?.id !== accountId || !state.settingsLoaded) return false
      if (action === 'favorites') {
        state.setSearchQuery('')
        state.clearTagFilters()
        // Use the settings coordinator so an in-flight full-settings load
        // cannot restore the previous filter over this explicit action.
        state.setSetting('filterTab', 'favorites')
        navigate('/characters')
      } else {
        const lastChat = state.activeChatId || lastIOSChat(accountId)
        const path = lastChat ? `/chat/${encodeURIComponent(lastChat)}` : '/'
        // Reopening the visible chat must preserve its draft, scroll and stream.
        if (window.location.pathname.replace(/\/$/, '') !== path.replace(/\/$/, '')) navigate(path)
      }
      return true
    })
  }, [accountId, ready, navigate])
}
