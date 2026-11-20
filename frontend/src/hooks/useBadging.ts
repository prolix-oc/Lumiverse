import { useEffect } from 'react'
import { useStore } from '@/store'
import { setBadge, clearBadge } from '@/lib/badging'
import i18n from '@/i18n'

/**
 * Manages the PWA app badge count. Increments when backgrounded events arrive,
 * clears when the app regains focus. Also listens for SW messages (background
 * sync completion, navigation from notification click).
 */
export function useBadging() {
  const badgeCount = useStore((s) => s.badgeCount)
  const resetBadgeCount = useStore((s) => s.resetBadgeCount)
  const addToast = useStore((s) => s.addToast)

  // Sync badge count to OS badge
  useEffect(() => {
    setBadge(badgeCount)
  }, [badgeCount])

  // Clear badge on focus / visibility
  useEffect(() => {
    const onFocus = () => {
      clearBadge()
      resetBadgeCount()
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        clearBadge()
        resetBadgeCount()
      }
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [resetBadgeCount])

  // Listen for service worker messages
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'BACKGROUND_SYNC_COMPLETE') {
        const count = event.data.count
        addToast({
          type: 'info',
          title: i18n.t('settings:badging.backgroundSyncTitle'),
          message: count == null
            ? i18n.t('settings:badging.backgroundSyncPending')
            : i18n.t('settings:badging.backgroundSyncMessage', { count }),
        })
      }
    }

    navigator.serviceWorker?.addEventListener('message', handler)
    return () => {
      navigator.serviceWorker?.removeEventListener('message', handler)
    }
  }, [addToast])
}
