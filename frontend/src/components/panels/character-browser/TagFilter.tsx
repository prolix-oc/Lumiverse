import { useState, useRef, useEffect } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { getTagColor } from '@/lib/tagColors'
import styles from './TagFilter.module.css'
import clsx from 'clsx'

interface TagInfo {
  tag: string
  count: number
}

interface TagFilterProps {
  allTags: TagInfo[]
  selectedTags: string[]
  onToggleTag: (tag: string) => void
  onClearTags: () => void
}

export default function TagFilter({
  allTags,
  selectedTags,
  onToggleTag,
  onClearTags,
}: TagFilterProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const filtered = search
    ? allTags.filter((t) => t.tag.toLowerCase().includes(search.toLowerCase()))
    : allTags

  if (allTags.length === 0) return null

  return (
    <div className={styles.container} ref={ref}>
      <button
        type="button"
        className={clsx(styles.trigger, selectedTags.length > 0 && styles.triggerActive)}
        onClick={() => setOpen(!open)}
      >
        <span>Tags{selectedTags.length > 0 ? ` (${selectedTags.length})` : ''}</span>
        <ChevronDown size={12} />
      </button>
      {selectedTags.length > 0 && (
        <button type="button" className={styles.clearBtn} onClick={onClearTags} title="Clear tags">
          <X size={12} />
        </button>
      )}
      {open && (
        <div className={styles.dropdown}>
          <input
            type="text"
            className={styles.search}
            placeholder="Search tags..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className={styles.list}>
            {filtered.map(({ tag, count }) => {
              const color = getTagColor(tag)
              const isSelected = selectedTags.includes(tag)
              return (
                <button
                  key={tag}
                  type="button"
                  className={clsx(styles.tagItem, isSelected && styles.tagItemSelected)}
                  onClick={() => onToggleTag(tag)}
                >
                  <span
                    className={styles.tagPill}
                    style={{ background: color.bg, color: color.text, borderColor: color.border }}
                  >
                    {tag}
                  </span>
                  <span className={styles.tagCount}>{count}</span>
                </button>
              )
            })}
            {filtered.length === 0 && (
              <div className={styles.empty}>No tags found</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
