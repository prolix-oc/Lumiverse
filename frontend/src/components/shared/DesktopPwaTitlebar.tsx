import { useTranslation } from 'react-i18next'
import { useContextualTitle } from '@/hooks/useContextualTitle'
import styles from './DesktopPwaTitlebar.module.css'

export default function DesktopPwaTitlebar() {
  const { t } = useTranslation('common')
  const context = useContextualTitle()
  const title = context || t('appName')

  return (
    <div className={styles.titlebar} aria-hidden="true">
      <div className={styles.dragRegion}>
        <div className={styles.brandMark} />
        <span className={styles.title}>{title}</span>
      </div>
    </div>
  )
}
