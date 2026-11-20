import { useEffect } from 'react'
import { pushApi } from '@/api/push'
import { getIOSNotificationStatus, hasIOSNativeBridge, registerIOSPush } from '@/lib/ios-native'
import { createIOSForegroundSync } from '@/lib/ios-foreground-sync'

/** Refresh an existing enrollment after APNs rotates its token; never prompt or enroll implicitly. */
export function useIOSPushSync(userId: string | null) {
  useEffect(() => {
    if (!userId || !hasIOSNativeBridge()) return
    const recovery = createIOSForegroundSync(async signal => {
      const status = await getIOSNotificationStatus()
      if (!status.available || status.permission !== 'granted' || signal.aborted) return
      const rows = await pushApi.listSubscriptions({ signal })
      if (signal.aborted || !rows.some(row => row.type === 'ios_apns' && row.device_id === status.deviceId
        && row.bundle_id === status.bundleId && row.environment === status.environment)) return
      const info = await pushApi.getIOSInfo(status.bundleId)
      if (!info.configured || (info.delivery === 'relay' && !status.relayAvailable) || signal.aborted) return
      const registration = await registerIOSPush(info.delivery || 'direct', info.relayUrl)
      if (!signal.aborted) await pushApi.subscribeIOS(registration, { signal })
    })
    window.addEventListener('lumiverse:ios-push-token', recovery.request)
    return () => {
      recovery.stop()
      window.removeEventListener('lumiverse:ios-push-token', recovery.request)
    }
  }, [userId])
}
