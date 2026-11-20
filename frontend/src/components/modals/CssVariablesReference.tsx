import { useTranslation } from 'react-i18next'
import { Palette } from 'lucide-react'
import GENERATED_VARS from '@/lib/generatedCssVariables'
import styles from './PropsReference.module.css'

export default function CssVariablesReference() {
  const { t } = useTranslation('modals', { keyPrefix: 'cssVariablesReference' })
  const vars = Object.entries(GENERATED_VARS)
  
  if (vars.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>
            <Palette size={13} />
            {t('title')}
          </span>
        </div>
        <div className={styles.list}>
          <div className={styles.emptyNote}>
            {t('empty')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>
          <Palette size={13} />
          {t('titleWithCount', { count: vars.length })}
        </span>
      </div>
      <div className={styles.list}>
        {vars.map(([name, value]) => (
          <div key={name} className={styles.group}>
            <div className={styles.propRow}>
              <div className={styles.propHeader}>
                <span className={styles.propName}>{name}</span>
              </div>
              <div className={styles.propDesc}>{value}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
