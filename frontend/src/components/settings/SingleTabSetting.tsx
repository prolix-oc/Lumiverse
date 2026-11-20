import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Toggle } from '@/components/shared/Toggle'
import { activeTab } from '@/lib/active-tab'
import styles from './RequestHistory.module.css'
import tabStyles from './SingleTabSetting.module.css'

function subscribe(listener: () => void) {
  window.addEventListener('storage', listener)
  window.addEventListener('active-tab-setting', listener)
  return () => {
    window.removeEventListener('storage', listener)
    window.removeEventListener('active-tab-setting', listener)
  }
}

export default function SingleTabSetting({ userId }: { userId: string }) {
  const { t } = useTranslation('settings')
  const enforced = useSyncExternalStore(subscribe, () => activeTab.isEnforced(userId))
  return (
    <section className={styles.section} aria-labelledby="setsec-account-singleTab">
      <div className={styles.header}>
        <div>
          <h3 className={styles.title} id="setsec-account-singleTab">{t('account.singleTab.label', 'Enforce one active browser tab')}</h3>
          <p className={styles.hint}>
            <strong className={tabStyles.warningPill}>{t('account.singleTab.warningLabel', 'Warning:')}</strong>{' '}
            {t('account.singleTab.warningMessage', 'having multiple tabs open and accidentally using the wrong one can cause irrecoverable issues in your lumiverse save data. Be warned.')}{' '}
            {t('account.singleTab.scope', 'Applies to this account in this browser.')}
          </p>
        </div>
        <Toggle.Switch
          checked={enforced}
          onChange={(checked) => {
            activeTab.setEnforced(userId, checked)
            window.dispatchEvent(new Event('active-tab-setting'))
          }}
          aria-label={t('account.singleTab.label', 'Enforce one active browser tab')}
        />
      </div>
    </section>
  )
}
