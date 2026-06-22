import { Eye, EyeOff, Trash2, X, CheckSquare, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMessageSelect } from '@/hooks/useMessageSelect'
import { useStore } from '@/store'
import styles from './MessageSelectBar.module.css'
import clsx from 'clsx'

interface MessageSelectBarProps {
  chatId: string
}

export default function MessageSelectBar({ chatId }: MessageSelectBarProps) {
  const { t } = useTranslation('chat')
  const { t: tc } = useTranslation('common')
  const {
    selectedCount,
    totalCount,
    hasHiddenSelected,
    hasVisibleSelected,
    exitSelectMode,
    selectAllMessages,
    clearMessageSelection,
    bulkHide,
    bulkDelete,
  } = useMessageSelect(chatId)

  const openModal = useStore((s) => s.openModal)

  const allSelected = selectedCount === totalCount && totalCount > 0

  const handleDelete = () => {
    openModal('confirm', {
      title: t('messageSelect.deleteTitle'),
      message: t('messageSelect.deleteMessage', { count: selectedCount }),
      variant: 'danger',
      confirmText: tc('actions.delete'),
      onConfirm: bulkDelete,
    })
  }

  return (
    <div className={styles.bar} data-component="MessageSelectBar">
      <div className={styles.left}>
        <button
          type="button"
          className={styles.selectToggle}
          onClick={allSelected ? clearMessageSelection : selectAllMessages}
          title={allSelected ? t('messageSelect.deselectAll') : t('messageSelect.selectAll')}
        >
          {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
        </button>
        <span className={styles.count}>
          {t('messageSelect.selectedCount', { selected: selectedCount, total: totalCount })}
        </span>
      </div>
      <div className={styles.actions}>
        {hasVisibleSelected && (
          <button
            type="button"
            className={clsx(styles.actionBtn, styles.hideBtn)}
            onClick={() => bulkHide(true)}
            disabled={selectedCount === 0}
          >
            <EyeOff size={13} />
            <span className={styles.actionLabel}>{t('messageActions.hide')}</span>
          </button>
        )}
        {hasHiddenSelected && (
          <button
            type="button"
            className={clsx(styles.actionBtn, styles.unhideBtn)}
            onClick={() => bulkHide(false)}
            disabled={selectedCount === 0}
          >
            <Eye size={13} />
            <span className={styles.actionLabel}>{t('messageActions.unhide')}</span>
          </button>
        )}
        <button
          type="button"
          className={clsx(styles.actionBtn, styles.deleteBtn)}
          onClick={handleDelete}
          disabled={selectedCount === 0}
        >
          <Trash2 size={13} />
          <span className={styles.actionLabel}>{tc('actions.delete')}</span>
        </button>
        <button
          type="button"
          className={clsx(styles.actionBtn, styles.cancelBtn)}
          onClick={exitSelectMode}
        >
          <X size={13} />
          <span className={styles.actionLabel}>{tc('actions.cancel')}</span>
        </button>
      </div>
    </div>
  )
}
