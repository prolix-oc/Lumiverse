import { useEffect, useId, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { TagCount } from '@/types/api'
import styles from './CharacterEditorPage.module.css'

/** Reuse the library's tags without changing how character tags are saved. */
export default function CharacterTagInput({ allTags, tags, onAdd, placeholder }: {
  allTags: TagCount[]
  tags: string[]
  onAdd: (tag: string) => void
  placeholder: string
}) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const suggestions = allTags.filter(({ tag }) => !tags.includes(tag) && tag.toLowerCase().includes(draft.trim().toLowerCase()))
  const activeIndex = suggestions.findIndex(({ tag }) => tag === activeTag)
  const expanded = open && suggestions.length > 0

  useEffect(() => {
    if (expanded) {
      const target = activeIndex >= 0 ? listRef.current?.children[activeIndex] : listRef.current
      target?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, expanded])

  const add = (raw: string) => {
    const tag = raw.trim()
    if (!tag || tags.includes(tag)) return
    onAdd(tag)
    setDraft('')
    setActiveTag(null)
    setOpen(false)
  }

  return <div className={styles.tagPicker} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }}>
    <div className={styles.tagAdd}>
      <input
        type="text"
        role="combobox"
        aria-label={placeholder}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        className={styles.tagInput}
        value={draft}
        placeholder={placeholder}
        onFocus={() => { setOpen(true); setActiveTag(null) }}
        onClick={() => setOpen(true)}
        onChange={event => { setDraft(event.target.value); setOpen(true); setActiveTag(null) }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setActiveTag(null) }
          } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length) {
            event.preventDefault()
            const next = !expanded || activeIndex < 0
              ? event.key === 'ArrowDown' ? 0 : suggestions.length - 1
              : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length
            setOpen(true)
            setActiveTag(suggestions[next].tag)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            add(expanded && activeIndex >= 0 ? suggestions[activeIndex].tag : draft)
          }
        }}
      />
      <button type="button" className={styles.tagAddBtn} aria-label={placeholder} onClick={() => add(draft)} disabled={!draft.trim() || tags.includes(draft.trim())}>
        <Plus size={12} />
      </button>
    </div>
    {expanded && <div ref={listRef} id={listId} role="listbox" aria-label={placeholder} className={styles.tagSuggestions}>
      {suggestions.map(({ tag }, index) => <button
        key={tag}
        id={`${listId}-${index}`}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={index === activeIndex}
        className={styles.tagSuggestion}
        onMouseDown={event => event.preventDefault()}
        onClick={() => add(tag)}
      >{tag}</button>)}
    </div>}
  </div>
}
