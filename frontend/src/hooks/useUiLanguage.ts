import { useEffect } from 'react'
import { applyLoginLanguage, changeUiLanguage } from '@/i18n'
import { useStore } from '@/store'

/** Auth screens use a device preference; authenticated screens use account settings. */
export function useUiLanguage() {
  const userId = useStore(s => s.isAuthenticated ? s.user?.id : null)
  const language = useStore(s => s.uiLanguage)

  useEffect(() => {
    let cancelled = false
    if (!userId) {
      const isCurrent = () => !cancelled && !useStore.getState().isAuthenticated
      void applyLoginLanguage(isCurrent).catch(error => {
        if (isCurrent()) console.error('[i18n] Failed to apply login language:', error)
      })
      return () => { cancelled = true }
    }
    if (!language) return
    const isCurrent = () => {
      const state = useStore.getState()
      return !cancelled && state.isAuthenticated && state.user?.id === userId
        && state.uiLanguage === language
    }
    // Applying a server value must never persist the device's detected language.
    void changeUiLanguage(language, isCurrent).catch(error => {
      if (isCurrent()) console.error('[i18n] Failed to apply account language:', error)
    })
    return () => { cancelled = true }
  }, [userId, language])
}
