import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, X, Check, Ban } from 'lucide-react'
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
  excludedTags: string[]
  /** Advance a tag through the filter states: neutral → include → exclude → neutral. */
  onCycleTag: (tag: string) => void
  /** Clear both included and excluded tags. */
  onClearTags: () => void
}

export default function TagFilter({
  allTags,
  selectedTags,
  excludedTags,
  onCycleTag,
  onClearTags,
}: TagFilterProps) {
  const { t } = useTranslation('panels')
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
    ? allTags.filter((tagInfo) => tagInfo.tag.toLowerCase().includes(search.toLowerCase()))
    : allTags

  const activeCount = selectedTags.length + excludedTags.length

  if (allTags.length === 0) return <div className={styles.placeholder} />

  return (
    <div className={styles.container} ref={ref}>
      <button
        type="button"
        className={clsx(styles.trigger, activeCount > 0 && styles.triggerActive)}
        onClick={() => setOpen(!open)}
      >
        <span>
          {activeCount > 0
            ? t('characterBrowser.tagFilter.labelWithCount', { count: activeCount })
            : t('characterBrowser.tagFilter.label')}
        </span>
        <ChevronDown size={12} />
      </button>
      {activeCount > 0 && (
        <button
          type="button"
          className={styles.clearBtn}
          onClick={onClearTags}
          title={t('characterBrowser.tagFilter.clearTags')}
        >
          <X size={12} />
        </button>
      )}
      {open && (
        <div className={styles.dropdown}>
          <input
            type="text"
            className={styles.search}
            placeholder={t('characterBrowser.tagFilter.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className={styles.list}>
            {filtered.map(({ tag, count }) => {
              const color = getTagColor(tag)
              const isIncluded = selectedTags.includes(tag)
              const isExcluded = excludedTags.includes(tag)
              const stateLabel = isIncluded
                ? t('characterBrowser.tagFilter.stateIncluded')
                : isExcluded
                  ? t('characterBrowser.tagFilter.stateExcluded')
                  : t('characterBrowser.tagFilter.stateNeutral')
              return (
                <button
                  key={tag}
                  type="button"
                  className={clsx(
                    styles.tagItem,
                    isIncluded && styles.tagItemIncluded,
                    isExcluded && styles.tagItemExcluded,
                  )}
                  onClick={() => onCycleTag(tag)}
                  title={stateLabel}
                >
                  <span className={styles.tagState} aria-hidden="true">
                    {isIncluded && <Check size={12} className={styles.iconInclude} />}
                    {isExcluded && <Ban size={12} className={styles.iconExclude} />}
                  </span>
                  <span
                    className={clsx(styles.tagPill, isExcluded && styles.tagPillExcluded)}
                    style={{ background: color.bg, color: color.text, borderColor: color.border }}
                  >
                    {tag}
                  </span>
                  <span className={styles.tagCount}>{count}</span>
                </button>
              )
            })}
            {filtered.length === 0 && (
              <div className={styles.empty}>{t('characterBrowser.tagFilter.noTagsFound')}</div>
            )}
          </div>
          <div className={styles.hint}>{t('characterBrowser.tagFilter.cycleHint')}</div>
        </div>
      )}
    </div>
  )
}
