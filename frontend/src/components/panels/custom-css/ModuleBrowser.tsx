import { useState, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { CSS_MODULE_REGISTRY, generateSelector, type CSSModuleEntry } from '@/lib/cssModuleRegistry'
import styles from './ModuleBrowser.module.css'
import clsx from 'clsx'

interface ModuleBrowserProps {
  onInsertSelector: (selector: string) => void
}

export default function ModuleBrowser({ onInsertSelector }: ModuleBrowserProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!search.trim()) return CSS_MODULE_REGISTRY
    const q = search.toLowerCase()
    return CSS_MODULE_REGISTRY.filter(
      (e) => e.component.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)
    )
  }, [search])

  // Group by category
  const grouped = useMemo(() => {
    const map = new Map<string, CSSModuleEntry[]>()
    for (const entry of filtered) {
      const existing = map.get(entry.category)
      if (existing) existing.push(entry)
      else map.set(entry.category, [entry])
    }
    return map
  }, [filtered])

  const handleClick = (entry: CSSModuleEntry, part?: string) => {
    const selector = generateSelector(entry, part)
    onInsertSelector(`${selector} {\n  \n}\n`)
  }

  return (
    <div className={styles.browser}>
      <div className={styles.header} onClick={() => setIsOpen(!isOpen)}>
        <span className={styles.headerLabel}>
          <ChevronRight
            size={12}
            className={clsx(styles.chevron, isOpen && styles.chevronOpen)}
          />
          Components ({CSS_MODULE_REGISTRY.length})
        </span>
      </div>

      {isOpen && (
        <>
          <input
            className={styles.searchInput}
            placeholder="Search components..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className={styles.list}>
            {[...grouped.entries()].map(([category, entries]) => (
              <div key={category}>
                <div className={styles.categoryLabel}>{category}</div>
                {entries.map((entry) => (
                  <div
                    key={entry.component}
                    className={styles.item}
                    onClick={() => handleClick(entry)}
                    title={`Insert selector for ${entry.component}`}
                  >
                    <div className={styles.itemLeft}>
                      <span className={styles.itemName}>{entry.component}</span>
                      <span className={styles.itemDesc}>{entry.category}</span>
                    </div>
                  </div>
                ))}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className={styles.itemDesc} style={{ padding: '8px' }}>
                No matching components
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
