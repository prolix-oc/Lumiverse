import { useEffect } from 'react'
import { useStore } from '@/store'
import { tokenizersApi } from '@/api/tokenizers'

/** Also covers bootstrap, connection edits, and chat-driven profile selection. */
export function useTokenizerWarmup(): void {
  const authenticated = useStore(state => state.isAuthenticated)
  const userId = useStore(state => state.user?.id)
  const chatId = useStore(state => state.activeChatId)
  const connection = useStore(state =>
    state.profiles.find(profile => profile.id === state.activeProfileId)
      ?? state.profiles.find(profile => profile.is_default))
  const connectionId = connection?.id
  const model = connection?.model

  useEffect(() => {
    if (!authenticated || !userId || !connectionId || !model) return
    // A quick run through the connection picker should warm only its final choice.
    const timer = setTimeout(() => {
      void tokenizersApi.warm(connectionId, chatId ?? undefined).catch(() => {})
    }, 150)
    return () => clearTimeout(timer)
  }, [authenticated, userId, connectionId, model, chatId])
}
