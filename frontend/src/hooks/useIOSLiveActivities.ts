import { useEffect } from 'react'
import { post, get } from '@/api/client'
import { useStore } from '@/store'
import { hasIOSNativeBridge, iosNativeRequest } from '@/lib/ios-native'
import { createIOSForegroundSync, isIOSForeground } from '@/lib/ios-foreground-sync'
import { getIOSActivityStatus, useIOSLiveActivitiesEnabled, type ActivitySnapshot } from '@/lib/ios-live-activities'

/** Only authoritative, foreground snapshots start activities; persisted chat heads never do. */
export function useIOSLiveActivities(userId: string | null | undefined) {
  const enabled = useIOSLiveActivitiesEnabled()
  useEffect(() => {
    if (!hasIOSNativeBridge() || userId === undefined) return
    const configure = async () => {
      const status = await iosNativeRequest<{ deviceId?: string; bundleId?: string; environment?: string }>('activities.configure', { accountId: userId, enabled: enabled && !!userId })
      if (userId && !enabled && status.deviceId) {
        await post('/push/ios/spindle-activities/disable', { deviceId: status.deviceId, bundleId: status.bundleId, environment: status.environment, serverOrigin: window.location.origin }).catch(() => {})
      }
    }
    // Account/preference changes must clean up even while the app is hidden.
    if (!userId || !enabled || !isIOSForeground()) void configure().catch(() => {})
    if (!userId || !enabled) return
    const recovery = createIOSForegroundSync(async signal => {
      await configure()
      if (signal.aborted) return
      const native = await getIOSActivityStatus()
      if (signal.aborted) return
      if (native.spindleAvailable === false) {
        await post('/push/ios/spindle-activities/disable', { deviceId: native.deviceId, bundleId: native.bundleId,
          environment: native.environment, serverOrigin: window.location.origin }, { signal }).catch(() => {})
      }
      if (signal.aborted || !native.available) return
      if (native.spindleAvailable) {
        try {
          const extensions = await post<{ items: unknown[] }>("/push/ios/spindle-activities/snapshot", {
            deviceId: native.deviceId, bundleId: native.bundleId, environment: native.environment, serverOrigin: window.location.origin,
            registrationIds: (native.spindleRegistrationIds ?? []).slice(0, 32),
          }, { signal })
          if (!signal.aborted && isIOSForeground()) await iosNativeRequest("activities.spindleSync", extensions)
        } catch { /* Notification enrollment may not be ready yet; retry on foreground recovery. */ }
      }
      if (signal.aborted) return
      const snapshot = await post<{ active: { generationId: string }[]; existing: ActivitySnapshot[] }>(
        '/push/ios/activities/snapshot', { generationIds: native.generationIds.slice(0, 32) }, { signal })
      if (signal.aborted) return
      await iosNativeRequest('activities.reconcile', { snapshots: snapshot.existing })
      if (signal.aborted) return
      const existing = new Set([...native.generationIds, ...native.suppressedGenerationIds])
      if (!snapshot.active.some(item => !existing.has(item.generationId))) return
      const info = await get<{ configured: boolean; bundleId: string; delivery?: 'relay' | 'direct' }>(
        '/push/ios/activities/info?bundleId=' + encodeURIComponent(native.bundleId), undefined, { signal })
      if (signal.aborted || !info.configured || info.bundleId !== native.bundleId) return
      if (info.delivery === 'relay' && !native.relayEnrolled) return
      for (const item of snapshot.active) {
        if (signal.aborted || !isIOSForeground()) break
        if (existing.has(item.generationId)) continue
        const enrollment = await post<Record<string, unknown>>('/push/ios/activities/prepare', {
          generationId: item.generationId, deviceId: native.deviceId, bundleId: native.bundleId,
          environment: native.environment, serverOrigin: window.location.origin,
        }, { signal })
        if (signal.aborted || !isIOSForeground()) break
        await iosNativeRequest('activities.start', enrollment)
      }
    }, 15_000)
    const unsubscribeStore = useStore.subscribe((state, previous) => {
      const signature = (heads: typeof state.chatHeads) => heads.map(h => `${h.generationId}:${h.status}`).join('|')
      if (state.chatHeads !== previous.chatHeads && signature(state.chatHeads) !== signature(previous.chatHeads)) recovery.request()
    })
    return () => {
      recovery.stop()
      unsubscribeStore()
    }
  }, [userId, enabled])
}
