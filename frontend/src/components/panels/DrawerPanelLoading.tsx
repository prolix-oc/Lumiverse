import { useTranslation } from 'react-i18next'
import { Spinner } from '@/components/shared/Spinner'
import styles from './DrawerPanelLoading.module.css'

export default function DrawerPanelLoading() {
  const { t } = useTranslation('common')
  return (
    <div className={styles.container} role="status" aria-label={t('actions.loading')} aria-busy="true" data-drawer-panel-loading>
      <div className={styles.indicator}>
        <Spinner size={24} />
        <span>{t('actions.loading')}</span>
      </div>
    </div>
  )
}
