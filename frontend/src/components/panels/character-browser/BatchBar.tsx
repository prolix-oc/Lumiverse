import { Trash2, X, CheckSquare, Tags } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import styles from './BatchBar.module.css'

interface BatchBarProps {
  selectedCount: number
  totalCount: number
  onSelectAll: () => void
  onClearSelection: () => void
  onTags: () => void
  onDelete: () => void
  onCancel: () => void
}

export default function BatchBar({
  selectedCount,
  totalCount,
  onSelectAll,
  onClearSelection,
  onTags,
  onDelete,
  onCancel,
}: BatchBarProps) {
  const { t } = useTranslation('panels')
  return (
    <div className={styles.bar}>
      <div className={styles.info}>
        <CheckSquare size={14} />
        <span>{t('characterBrowser.batchSelected', { selected: selectedCount, total: totalCount })}</span>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.btn}
          onClick={selectedCount === totalCount ? onClearSelection : onSelectAll}
        >
          {selectedCount === totalCount ? t('characterBrowser.deselectAll') : t('characterBrowser.selectAll')}
        </button>
        <button
          type="button"
          className={styles.tagsBtn}
          onClick={onTags}
          disabled={selectedCount === 0}
        >
          <Tags size={14} />
          {t('characterBrowser.bulkTags')}
        </button>
        <button
          type="button"
          className={styles.deleteBtn}
          onClick={onDelete}
          disabled={selectedCount === 0}
        >
          <Trash2 size={14} />
          {t('characterBrowser.delete')}
        </button>
        <button type="button" className={styles.cancelBtn} onClick={onCancel} title={t('characterBrowser.exitBatchMode')}>
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
