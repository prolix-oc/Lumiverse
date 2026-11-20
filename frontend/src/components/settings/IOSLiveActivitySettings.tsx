import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { hasIOSNativeBridge } from '@/lib/ios-native'
import { getIOSActivityStatus, setIOSLiveActivitiesEnabled, useIOSLiveActivitiesEnabled } from '@/lib/ios-live-activities'
import { Toggle } from '@/components/shared/Toggle'
import styles from './NotificationSettings.module.css'

export default function IOSLiveActivitySettings() {
  const { t } = useTranslation('settings')
  const enabled = useIOSLiveActivitiesEnabled()
  const [reason, setReason] = useState<string | null>(null)
  useEffect(() => {
    if (!hasIOSNativeBridge()) return
    let disposed = false
    void Promise.all([getIOSActivityStatus(), get<{ configured: boolean; reason: string | null }>('/push/ios/activities/info')])
      .then(([native, server]) => {
        if (!disposed) setReason(!native.available
          ? t('notifications.liveActivitiesUnavailable', { defaultValue: 'Requires iOS 16.1 or later, a push-enabled app build, and Live Activities enabled in iOS Settings.' })
          : server.reason)
      }).catch(() => {
        if (!disposed) setReason(t('notifications.liveActivitiesUpdateApp', { defaultValue: 'Update the iOS app and server to use Live Activities.' }))
      })
    return () => { disposed = true }
  }, [t])
  if (!hasIOSNativeBridge()) return null
  return <div className={styles.section}>
    <div className={styles.sectionHeader}>{t('notifications.liveActivities', { defaultValue: 'Live Activities' })}</div>
    <div className={styles.toggleRow}>
      <Toggle.Checkbox checked={enabled} onChange={setIOSLiveActivitiesEnabled}
        label={t('notifications.liveActivitiesEnable', { defaultValue: 'Show generation status on the Lock Screen' })}
        hint={reason || t('notifications.liveActivitiesHint', {
          defaultValue: 'Shows the character name and generation phase on the Lock Screen and Dynamic Island. Message content stays private. Applies to this device.',
        })} />
    </div>
  </div>
}
