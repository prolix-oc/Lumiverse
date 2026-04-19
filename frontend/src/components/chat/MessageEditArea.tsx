import { Brain } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import styles from './MessageEditArea.module.css'

interface MessageEditAreaProps {
  editContent: string
  onChangeContent: (value: string) => void
  onSave: () => void
  onCancel: () => void
  editReasoning?: string
  onChangeReasoning?: (value: string) => void
}

// Auto-grow a textarea to fit its content, bounded by its CSS min/max-height.
function autoResize(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

export default function MessageEditArea({
  editContent, onChangeContent, onSave, onCancel,
  editReasoning, onChangeReasoning,
}: MessageEditAreaProps) {
  const hasReasoning = editReasoning != null && onChangeReasoning != null
  const contentRef = useRef<HTMLTextAreaElement>(null)
  const reasoningRef = useRef<HTMLTextAreaElement>(null)

  // Fit to initial content on mount, and re-fit when the value changes externally.
  useEffect(() => { autoResize(contentRef.current) }, [editContent])
  useEffect(() => { autoResize(reasoningRef.current) }, [editReasoning])

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChangeContent(e.target.value)
    autoResize(e.currentTarget)
  }, [onChangeContent])

  const handleReasoningChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChangeReasoning?.(e.target.value)
    autoResize(e.currentTarget)
  }, [onChangeReasoning])

  return (
    <div className={styles.editArea}>
      {hasReasoning && (
        <div className={styles.reasoningSection}>
          <div className={styles.sectionLabel}>
            <Brain size={13} />
            <span>Reasoning</span>
          </div>
          <textarea
            ref={reasoningRef}
            className={`${styles.editTextarea} ${styles.reasoningTextarea}`}
            value={editReasoning}
            onChange={handleReasoningChange}
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
          ref={contentRef}
          className={styles.editTextarea}
          value={editContent}
          onChange={handleContentChange}
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
