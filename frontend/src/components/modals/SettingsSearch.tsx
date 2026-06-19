import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { getSettingsSearchIndex, type SettingsSearchEntry } from '@/lib/settings-tab-registry'
import styles from './SettingsSearch.module.css'

interface SettingsSearchProps {
  /** Open the given tab and (optionally) scroll to a section anchor. */
  onNavigate: (tabId: string, anchorId: string | null) => void
}

interface ResultGroup {
  tabId: string
  group: string
  items: SettingsSearchEntry[]
}

function highlight(text: string, query: string): ReactNode {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className={styles.match}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

export default function SettingsSearch({ onNavigate }: SettingsSearchProps) {
  const { t, i18n } = useTranslation('settings')
  const userRole = useStore((s) => s.user?.role)

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const openedAt = useRef(0)

  // Rebuild the index when role or language changes (titles are resolved at build time).
  const index = useMemo(
    () => getSettingsSearchIndex(userRole),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userRole, i18n.language],
  )

  const { groups, flat } = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return { groups: [] as ResultGroup[], flat: [] as SettingsSearchEntry[] }

    const score = (e: SettingsSearchEntry): number => {
      const title = e.title.toLowerCase()
      if (title.startsWith(q)) return 0
      if (title.includes(q)) return 1
      if (e.group.toLowerCase().includes(q)) return 2
      return 3
    }

    const matched = index
      .map((e) => ({ e, s: score(e) }))
      .filter(({ e, s }) => s < 3 || e.keywords.some((k) => k.toLowerCase().includes(q)))

    // Group by tab in first-appearance order, then order groups by their best match.
    const byTab = new Map<string, ResultGroup>()
    const tabScore = new Map<string, number>()
    for (const { e, s } of matched) {
      let g = byTab.get(e.tabId)
      if (!g) {
        g = { tabId: e.tabId, group: e.group, items: [] }
        byTab.set(e.tabId, g)
      }
      g.items.push(e)
      tabScore.set(e.tabId, Math.min(tabScore.get(e.tabId) ?? 99, s))
    }

    const orderedGroups = [...byTab.values()].sort(
      (a, b) => (tabScore.get(a.tabId)! - tabScore.get(b.tabId)!),
    )

    const flatList: SettingsSearchEntry[] = []
    for (const g of orderedGroups) {
      g.items.sort((a, b) => score(a) - score(b))
      flatList.push(...g.items)
    }

    return { groups: orderedGroups, flat: flatList }
  }, [index, query])

  // Keep the active index within bounds as results change.
  useEffect(() => {
    setActiveIndex((i) => (flat.length === 0 ? 0 : Math.min(i, flat.length - 1)))
  }, [flat.length])

  // Outside-click dismissal — pointerdown + openedAt guard for Android (see CLAUDE.md).
  useEffect(() => {
    if (!open) return
    openedAt.current = performance.now()
    const onDown = (e: PointerEvent) => {
      if (performance.now() - openedAt.current < 100) return
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const showDropdown = open && query.trim().length > 0

  function select(entry: SettingsSearchEntry) {
    onNavigate(entry.tabId, entry.anchorId)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  function scrollActiveIntoView(next: number) {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showDropdown && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true)
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((i) => {
          const next = Math.min(i + 1, flat.length - 1)
          scrollActiveIntoView(next)
          return next
        })
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => {
          const next = Math.max(i - 1, 0)
          scrollActiveIntoView(next)
          return next
        })
        break
      case 'Enter':
        e.preventDefault()
        if (flat[activeIndex]) select(flat[activeIndex])
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        if (query) {
          setQuery('')
        } else {
          setOpen(false)
          inputRef.current?.blur()
        }
        break
    }
  }

  let flatIdx = -1

  return (
    <div ref={containerRef} className={styles.container}>
      <div className={styles.inputRow}>
        <Search size={14} className={styles.searchIcon} strokeWidth={1.75} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="settings-search-list"
          aria-autocomplete="list"
          className={styles.input}
          placeholder={t('search.placeholder', { defaultValue: 'Search settings…' })}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveIndex(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
        />
        {query && (
          <button
            type="button"
            className={styles.clearBtn}
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
            tabIndex={-1}
            aria-label={t('search.clear', { defaultValue: 'Clear search' })}
          >
            <X size={13} />
          </button>
        )}
      </div>

      {showDropdown && (
        <div
          ref={listRef}
          id="settings-search-list"
          className={styles.dropdown}
          role="listbox"
          aria-label={t('search.resultsAria', { defaultValue: 'Settings search results' })}
        >
          {flat.length === 0 ? (
            <div className={styles.empty}>{t('search.noResults', { defaultValue: 'No matching settings', query })}</div>
          ) : (
            groups.map((g) => (
              <div key={g.tabId} className={styles.group} role="group" aria-label={g.group}>
                <div className={styles.groupLabel}>{g.group}</div>
                {g.items.map((entry) => {
                  flatIdx += 1
                  const idx = flatIdx
                  const isActive = idx === activeIndex
                  const Icon = entry.icon
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      data-idx={idx}
                      className={clsx(styles.item, isActive && styles.itemActive)}
                      onPointerDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => select(entry)}
                    >
                      <span className={styles.itemIcon}>
                        <Icon size={14} strokeWidth={1.75} />
                      </span>
                      <span className={styles.itemTitle}>{highlight(entry.title, query.trim())}</span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
