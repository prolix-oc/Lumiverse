import { useEffect, useId, useState } from 'react'
import { CheckSquare, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import type { WorldBook } from '@/types/api'
import styles from './PersonaBulkBar.module.css'

export type PersonaBulkAction =
  | 'move'
  | 'attachLorebook'
  | 'removeLorebook'
  | 'toggleNarrator'
  | 'export'
  | 'delete'

interface PersonaBulkBarProps {
  selectedCount: number
  totalCount: number
  folders: string[]
  worldBooks: WorldBook[]
  busy: boolean
  onSelectAll: () => void
  onClearSelection: () => void
  onCancel: () => void
  onApply: (action: PersonaBulkAction, value?: string) => Promise<boolean>
}

export default function PersonaBulkBar({
  selectedCount,
  totalCount,
  folders,
  worldBooks,
  busy,
  onSelectAll,
  onClearSelection,
  onCancel,
  onApply,
}: PersonaBulkBarProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'personaManager.bulk' })
  const [action, setAction] = useState<PersonaBulkAction | ''>('')
  const [folder, setFolder] = useState('')
  const [worldBookId, setWorldBookId] = useState('')
  const folderListId = useId()

  useEffect(() => {
    if (selectedCount === 0) setAction('')
  }, [selectedCount])

  const needsLorebook = action === 'attachLorebook'
  const canApply = selectedCount > 0 && !!action && (!needsLorebook || !!worldBookId)

  const apply = async () => {
    if (!action || !canApply || busy) return
    const value = action === 'move' ? folder : action === 'attachLorebook' ? worldBookId : undefined
    if (await onApply(action, value)) {
      setAction('')
      setFolder('')
      setWorldBookId('')
    }
  }

  return (
    <div className={styles.bar}>
      <div className={styles.summaryRow}>
        <span className={styles.info}>
          <CheckSquare size={14} />
          {t('selected', { selected: selectedCount, total: totalCount })}
        </span>
        <button
          type="button"
          className={styles.linkBtn}
          onClick={selectedCount === totalCount ? onClearSelection : onSelectAll}
          disabled={totalCount === 0 || busy}
        >
          {selectedCount === totalCount ? t('deselectAll') : t('selectAll')}
        </button>
        <button type="button" className={styles.closeBtn} onClick={onCancel} disabled={busy} title={t('exit')}>
          <X size={14} />
        </button>
      </div>

      <div className={styles.actionRow}>
        <select
          className={styles.select}
          value={action}
          onChange={(event) => setAction(event.target.value as PersonaBulkAction | '')}
          disabled={busy}
          aria-label={t('action')}
        >
          <option value="">{t('action')}</option>
          <option value="move">{t('move')}</option>
          <option value="attachLorebook">{t('attachLorebook')}</option>
          <option value="removeLorebook">{t('removeLorebook')}</option>
          <option value="toggleNarrator">{t('toggleNarrator')}</option>
          <option value="export">{t('export')}</option>
          <option value="delete">{t('delete')}</option>
        </select>

        {action === 'move' && (
          <>
            <input
              className={styles.targetInput}
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              placeholder={t('uncategorized')}
              list={folderListId}
              disabled={busy}
              aria-label={t('folder')}
            />
            <datalist id={folderListId}>
              {folders.map((name) => <option key={name} value={name} />)}
            </datalist>
          </>
        )}

        {needsLorebook && (
          <select
            className={styles.targetInput}
            value={worldBookId}
            onChange={(event) => setWorldBookId(event.target.value)}
            disabled={busy}
            aria-label={t('lorebook')}
          >
            <option value="">{t('chooseLorebook')}</option>
            {worldBooks.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}
          </select>
        )}

        <button
          type="button"
          className={clsx(styles.applyBtn, action === 'delete' && styles.deleteBtn)}
          onClick={() => void apply()}
          disabled={!canApply || busy}
        >
          {busy ? t('working') : t('apply')}
        </button>
      </div>
    </div>
  )
}
