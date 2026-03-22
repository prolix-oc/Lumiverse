import { Pencil, Trash2, Copy, Check, BarChart3, EyeOff, Eye, GitBranch } from 'lucide-react'
import { useState, useCallback } from 'react'
import styles from './MessageActions.module.css'

interface MessageActionsProps {
  onEdit: () => void
  onDelete: () => void
  onToggleHidden: () => void
  onFork: () => void
  onPromptBreakdown?: () => void
  isUser: boolean
  isHidden: boolean
  content: string
}

export default function MessageActions({ onEdit, onDelete, onToggleHidden, onFork, onPromptBreakdown, isUser, isHidden, content }: MessageActionsProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).catch(console.error)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [content])

  return (
    <div className={styles.actions}>
      <button type="button" className={styles.btn} onClick={onEdit} title="Edit" aria-label="Edit">
        <Pencil size={13} />
      </button>
      <button type="button" className={styles.btn} onClick={handleCopy} title="Copy" aria-label="Copy">
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <button
        type="button"
        className={styles.btn}
        onClick={onToggleHidden}
        title={isHidden ? 'Unhide from AI context' : 'Hide from AI context'}
        aria-label={isHidden ? 'Unhide' : 'Hide'}
      >
        {isHidden ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
      <button type="button" className={styles.btn} onClick={onFork} title="Fork chat here" aria-label="Fork chat">
        <GitBranch size={13} />
      </button>
      {onPromptBreakdown && (
        <button type="button" className={styles.btn} onClick={onPromptBreakdown} title="Prompt Breakdown" aria-label="Prompt Breakdown">
          <BarChart3 size={13} />
        </button>
      )}
      <button type="button" className={styles.deleteBtn} onClick={onDelete} title="Delete" aria-label="Delete">
        <Trash2 size={13} />
      </button>
    </div>
  )
}
