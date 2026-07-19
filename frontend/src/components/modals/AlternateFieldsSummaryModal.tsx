import { useTranslation } from 'react-i18next'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import styles from './LorebookImportModal.module.css'

export interface AlternateFieldsSummaryInfo {
  characterName: string
  fieldCounts: Record<string, number>
  hasAlternateAvatars: boolean
}

interface Props {
  isOpen: boolean
  items: AlternateFieldsSummaryInfo[]
  onClose: () => void
}

const FIELD_KEYS: Record<string, 'fieldDescription' | 'fieldPersonality' | 'fieldScenario'> = {
  description: 'fieldDescription',
  personality: 'fieldPersonality',
  scenario: 'fieldScenario',
}

export default function AlternateFieldsSummaryModal({ isOpen, items, onClose }: Props) {
  const { t } = useTranslation('modals', { keyPrefix: 'alternateFieldsSummary' })

  return (
    <ModalShell isOpen={isOpen && items.length > 0} onClose={onClose} maxWidth={580}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>{t('title')}</span>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <div className={styles.body}>
        <p style={{ fontSize: 12, color: 'var(--lumiverse-text-dim)', margin: '0 0 8px' }}>
          {t('intro')}
        </p>
        <div className={styles.lorebookList}>
          {items.map((item, i) => (
            <div key={i} className={styles.lorebookItem} style={{ cursor: 'default' }}>
              <div className={styles.lorebookInfo}>
                <span className={styles.lorebookName}>{item.characterName}</span>
                <span className={styles.lorebookMeta}>
                  {Object.entries(item.fieldCounts)
                    .filter(([, count]) => count > 0)
                    .map(([field, count]) => {
                      const labelKey = FIELD_KEYS[field]
                      const label = labelKey ? t(labelKey) : field
                      return t('variants', { label, count })
                    })
                    .join(', ')}
                  {item.hasAlternateAvatars && `, ${t('alternateAvatars')}`}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.footer}>
        <Button variant="primary" onClick={onClose}>
          {t('gotIt')}
        </Button>
      </div>
    </ModalShell>
  )
}
