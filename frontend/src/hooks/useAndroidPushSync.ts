import { useEffect } from 'react'
import { pushApi } from '@/api/push'
import { androidNativeRequest, clearAndroidEnrollment, getAndroidNotificationStatus, hasAndroidNativeBridge, registerAndroidPush, androidRegistrationReason, type AndroidPushRegistration } from '@/lib/android-native'

/** Reconcile existing opt-in on startup, account changes, token rotation and native resume. */
export function useAndroidPushSync(accountId: string | null | undefined) {
  useEffect(() => {
    if (accountId === undefined || !hasAndroidNativeBridge()) return
    const abort = new AbortController()
    let running = false
    const sync = async () => {
      if (running || abort.signal.aborted) return
      running = true
      let registration: AndroidPushRegistration | null = null
      let createdDestination: string | undefined
      let activated = false
      try {
        await androidNativeRequest('notifications.account', { accountId })
        if (!accountId) return
        const [status, rows, info] = await Promise.all([getAndroidNotificationStatus(), pushApi.listSubscriptions({ signal: abort.signal }), pushApi.getAndroidInfo()])
        if (abort.signal.aborted) return
        const current = rows.find(row => row.type === 'android_native' && row.device_id === status.deviceId)
        if (!current) { if (status.enrollment) await clearAndroidEnrollment(status.enrollment.destinationId); return }
        if (status.permission !== 'granted' || androidRegistrationReason(status, info)) return
        registration = await registerAndroidPush(info, abort.signal)
        if (!registration || abort.signal.aborted) return
        const fresh = await androidNativeRequest<boolean>('notifications.current', { ...registration, destinationId: current.id, serverInstanceId: info.serverInstanceId })
        if (fresh || abort.signal.aborted) return
        const enrollment = await pushApi.subscribeAndroid(registration, { signal: abort.signal })
        if (enrollment.destination.id !== current.id) createdDestination = enrollment.destination.id
        if (abort.signal.aborted) return
        await androidNativeRequest('notifications.save', { ...enrollment, enrollmentId: registration.enrollmentId, deviceToken: registration.deviceToken, accountId, serverOrigin: window.location.origin })
        activated = true
      } catch { /* Retry at next resume; no implicit permission prompts. */ }
      finally {
        if (!activated) {
          if (createdDestination) await pushApi.unsubscribe(createdDestination).catch(() => {})
          if (registration?.enrollmentId) await androidNativeRequest('notifications.cancel', { enrollmentId: registration.enrollmentId }).catch(() => {})
        }
        running = false
      }
    }
    void sync()
    window.addEventListener('lumiverse:android-resume', sync)
    window.addEventListener('lumiverse:android-push-token', sync)
    return () => { abort.abort(); window.removeEventListener('lumiverse:android-resume', sync); window.removeEventListener('lumiverse:android-push-token', sync) }
  }, [accountId])
}
