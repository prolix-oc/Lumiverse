import { useTranslation } from 'react-i18next'
import { BookOpen } from 'lucide-react'
import type { PropDoc } from '@/lib/componentTemplates'
import styles from './PropsReference.module.css'
import clsx from 'clsx'

interface PropsReferenceProps {
  props: PropDoc[]
  componentName: string
}

export default function PropsReference({ props, componentName }: PropsReferenceProps) {
  const { t } = useTranslation('modals', { keyPrefix: 'propsReference' })

  if (props.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>
            <BookOpen size={13} />
            {t('title')}
          </span>
        </div>
        <div className={styles.list}>
          <div className={styles.emptyNote}>
            {t('noProps', { name: componentName })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>
          <BookOpen size={13} />
          {t('titleWithCount', { count: props.length })}
        </span>
      </div>
      <div className={styles.list}>
        {props.map((prop) => (
          <div key={prop.name} className={styles.group}>
            <div className={styles.propRow}>
              <div className={styles.propHeader}>
                <span className={styles.propName}>{prop.name}</span>
                {prop.type && <span className={styles.propType}>{prop.type}</span>}
              </div>
              <div className={clsx(styles.propDesc, !prop.description && styles.propDescMuted)}>
                {prop.description || t('noDescription')}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
