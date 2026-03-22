import { useState, useCallback } from 'react'
import { Copy, Check, Pencil, Trash2, EyeOff, Eye, GitBranch } from 'lucide-react'
import styles from './BubbleActions.module.css'

interface BubbleActionsProps {
  onEdit: () => void
  onDelete: () => void
  onToggleHidden: () => void
  onFork: () => void
  isHidden: boolean
  content: string
  className?: string
}

export default function BubbleActions({ onEdit, onDelete, onToggleHidden, onFork, isHidden, content, className }: BubbleActionsProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).catch(console.error)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [content])

  return (
    <div className={className ? `${styles.pill} ${className}` : styles.pill}>
      <button type="button" onClick={handleCopy} title="Copy" aria-label="Copy">
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <button type="button" onClick={onEdit} title="Edit" aria-label="Edit">
        <Pencil size={13} />
      </button>
      <button
        type="button"
        onClick={onToggleHidden}
        title={isHidden ? 'Unhide from AI context' : 'Hide from AI context'}
        aria-label={isHidden ? 'Unhide' : 'Hide'}
      >
        {isHidden ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
      <button type="button" onClick={onFork} title="Fork chat here" aria-label="Fork chat">
        <GitBranch size={13} />
      </button>
      <button type="button" onClick={onDelete} title="Delete" aria-label="Delete">
        <Trash2 size={13} />
      </button>
    </div>
  )
}
