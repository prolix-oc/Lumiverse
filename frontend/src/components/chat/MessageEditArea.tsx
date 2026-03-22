import { Brain } from 'lucide-react'
import styles from './MessageEditArea.module.css'

interface MessageEditAreaProps {
  editContent: string
  onChangeContent: (value: string) => void
  onSave: () => void
  onCancel: () => void
  editReasoning?: string
  onChangeReasoning?: (value: string) => void
}

export default function MessageEditArea({
  editContent, onChangeContent, onSave, onCancel,
  editReasoning, onChangeReasoning,
}: MessageEditAreaProps) {
  const hasReasoning = editReasoning != null && onChangeReasoning != null

  return (
    <div className={styles.editArea}>
      {hasReasoning && (
        <div className={styles.reasoningSection}>
          <div className={styles.sectionLabel}>
            <Brain size={13} />
            <span>Reasoning</span>
          </div>
          <textarea
            className={`${styles.editTextarea} ${styles.reasoningTextarea}`}
            value={editReasoning}
            onChange={(e) => onChangeReasoning(e.target.value)}
            placeholder="Reasoning content (optional)"
          />
        </div>
      )}
      <div className={hasReasoning ? styles.contentSection : undefined}>
        {hasReasoning && (
          <div className={styles.sectionLabel}>
            <span>Response</span>
          </div>
        )}
        <textarea
          className={styles.editTextarea}
          value={editContent}
          onChange={(e) => onChangeContent(e.target.value)}
          autoFocus
        />
      </div>
      <div className={styles.editActions}>
        <button type="button" onClick={onCancel} className={styles.editCancelBtn}>
          Cancel
        </button>
        <button type="button" onClick={onSave} className={styles.editSaveBtn}>
          Save
        </button>
      </div>
    </div>
  )
}
