import { useCallback, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { systemAudioConsent } from '@/lib/spindle/system-audio-consent'
import styles from './SystemAudioConsentControl.module.css'

export default function SystemAudioConsentControl({ extensionId, granted }: { extensionId: string; granted: boolean }) {
  const { t } = useTranslation('shared', { keyPrefix: 'spindle.systemAudio' })
  const userId = useStore((s) => s.user?.id ?? null)
  const subscribe = useCallback((changed: () => void) => systemAudioConsent.subscribe(userId, extensionId, changed), [userId, extensionId])
  const snapshot = useCallback(() => systemAudioConsent.read(userId, extensionId), [userId, extensionId])
  const consent = useSyncExternalStore(subscribe, snapshot, snapshot)
  return (
    <div className={styles.control}>
      <div className={styles.description}>
        <span className={styles.title}>{t('consentSetting')}</span>
        <span>{t(consent.paused ? 'paused' : consent.remembered ? 'remembered' : 'askEachTime')}</span>
      </div>
      <div className={styles.actions}>
        {consent.paused && (
          <button type="button" disabled={!granted} onClick={() => systemAudioConsent.resume(userId, extensionId)}>
            {t('allowAgain')}
          </button>
        )}
        {consent.remembered && (
          <button type="button" onClick={() => systemAudioConsent.revoke(userId, extensionId)}>
            {t('revokeApproval')}
          </button>
        )}
      </div>
    </div>
  )
}
