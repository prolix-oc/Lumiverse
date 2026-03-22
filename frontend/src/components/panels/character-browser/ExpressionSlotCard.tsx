import { useState, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import LazyImage from '@/components/shared/LazyImage'
import { expressionsApi } from '@/api/expressions'
import styles from './ExpressionSlotCard.module.css'

interface Props {
  label: string
  imageId: string
  onDelete: (label: string) => void
  onRename: (oldLabel: string, newLabel: string) => void
  onPreview: (imageUrl: string) => void
}

export default function ExpressionSlotCard({ label, imageId, onDelete, onRename, onPreview }: Props) {
  const [editLabel, setEditLabel] = useState(label)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const handleLabelChange = useCallback(
    (value: string) => {
      setEditLabel(value)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        const trimmed = value.trim()
        if (trimmed && trimmed !== label) {
          onRename(label, trimmed)
        }
      }, 2000)
    },
    [label, onRename]
  )

  return (
    <div className={styles.card}>
      <div className={styles.imageWrap} onClick={() => onPreview(expressionsApi.imageUrl(imageId))}>
        <LazyImage
          src={expressionsApi.thumbnailUrl(imageId)}
          alt={label}
          className={styles.image}
        />
        <button
          type="button"
          className={styles.deleteBtn}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(label)
          }}
          aria-label={`Delete ${label}`}
        >
          <X size={12} />
        </button>
      </div>
      <input
        type="text"
        className={styles.labelInput}
        value={editLabel}
        onChange={(e) => handleLabelChange(e.target.value)}
        onBlur={() => {
          clearTimeout(timer.current)
          const trimmed = editLabel.trim()
          if (trimmed && trimmed !== label) onRename(label, trimmed)
        }}
        spellCheck={false}
      />
    </div>
  )
}
