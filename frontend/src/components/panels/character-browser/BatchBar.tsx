import { Trash2, X, CheckSquare } from 'lucide-react'
import styles from './BatchBar.module.css'

interface BatchBarProps {
  selectedCount: number
  totalCount: number
  onSelectAll: () => void
  onClearSelection: () => void
  onDelete: () => void
  onCancel: () => void
}

export default function BatchBar({
  selectedCount,
  totalCount,
  onSelectAll,
  onClearSelection,
  onDelete,
  onCancel,
}: BatchBarProps) {
  return (
    <div className={styles.bar}>
      <div className={styles.info}>
        <CheckSquare size={14} />
        <span>{selectedCount} of {totalCount} selected</span>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.btn}
          onClick={selectedCount === totalCount ? onClearSelection : onSelectAll}
        >
          {selectedCount === totalCount ? 'Deselect All' : 'Select All'}
        </button>
        <button
          type="button"
          className={styles.deleteBtn}
          onClick={onDelete}
          disabled={selectedCount === 0}
        >
          <Trash2 size={14} />
          Delete
        </button>
        <button type="button" className={styles.cancelBtn} onClick={onCancel} title="Exit batch mode">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
