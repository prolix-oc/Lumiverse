import { useState } from 'react'
import { Trash2, X, CheckSquare, Tags, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import FolderDropdown from '@/components/shared/FolderDropdown'
import styles from './BatchBar.module.css'

interface BatchBarProps {
  selectedCount: number
  totalCount: number
  onSelectAll: () => void
  onClearSelection: () => void
  onTags: () => void
  folders: string[]
  moveBusy: boolean
  onCreateFolder: (name: string) => void
  onMove: (folder: string) => Promise<boolean>
  onDelete: () => void
  onCancel: () => void
}

export default function BatchBar({
  selectedCount,
  totalCount,
  onSelectAll,
  onClearSelection,
  onTags,
  folders,
  moveBusy,
  onCreateFolder,
  onMove,
  onDelete,
  onCancel,
}: BatchBarProps) {
  const { t } = useTranslation('panels')
  const [moveFolder, setMoveFolder] = useState('')
  const [hasMoveTarget, setHasMoveTarget] = useState(false)

  const handleMove = async () => {
    if (!hasMoveTarget || moveBusy || selectedCount === 0) return
    if (await onMove(moveFolder)) {
      setMoveFolder('')
      setHasMoveTarget(false)
    }
  }

  return (
    <div className={styles.bar}>
      <div className={styles.info}>
        <CheckSquare size={14} />
        <span>{t('characterBrowser.batchSelected', { selected: selectedCount, total: totalCount })}</span>
      </div>
      <div className={styles.actions}>
        <div className={styles.moveControls}>
          <FolderDropdown
            folders={folders}
            selectedFolder={moveFolder}
            onSelect={(folder) => {
              setMoveFolder(folder)
              setHasMoveTarget(true)
            }}
            onCreateFolder={onCreateFolder}
            placeholder={t('characterBrowser.moveToFolder')}
            className={styles.folderPicker}
          />
          <button
            type="button"
            className={styles.moveBtn}
            onClick={() => void handleMove()}
            disabled={!hasMoveTarget || selectedCount === 0 || moveBusy}
          >
            <FolderOpen size={14} />
            {moveBusy ? t('characterBrowser.moving') : t('characterBrowser.move')}
          </button>
        </div>
        <button
          type="button"
          className={styles.btn}
          onClick={selectedCount === totalCount ? onClearSelection : onSelectAll}
          disabled={moveBusy}
        >
          {selectedCount === totalCount ? t('characterBrowser.deselectAll') : t('characterBrowser.selectAll')}
        </button>
        <button
          type="button"
          className={styles.tagsBtn}
          onClick={onTags}
          disabled={selectedCount === 0 || moveBusy}
        >
          <Tags size={14} />
          {t('characterBrowser.bulkTags')}
        </button>
        <button
          type="button"
          className={styles.deleteBtn}
          onClick={onDelete}
          disabled={selectedCount === 0 || moveBusy}
        >
          <Trash2 size={14} />
          {t('characterBrowser.delete')}
        </button>
        <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={moveBusy} title={t('characterBrowser.exitBatchMode')}>
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
