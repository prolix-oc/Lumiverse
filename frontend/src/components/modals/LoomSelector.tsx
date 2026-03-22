import { useState, useMemo, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Search, X, XCircle, ChevronDown, ChevronUp, BookOpen, Wrench, Zap } from 'lucide-react'
import type { LoomItem, LoomItemCategory, PackWithItems } from '@/types/api'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import styles from './LoomSelector.module.css'
import clsx from 'clsx'

interface LoomSelectorProps {
  category: LoomItemCategory
  onClose: () => void
}

const CATEGORY_CONFIG: Record<LoomItemCategory, { title: string; subtitle: string; icon: typeof BookOpen }> = {
  narrative_style: {
    title: 'Narrative Styles',
    subtitle: 'Choose writing styles to shape the narrative voice',
    icon: BookOpen,
  },
  loom_utility: {
    title: 'Loom Utilities',
    subtitle: 'Choose utility prompts for enhanced output control',
    icon: Wrench,
  },
  retrofit: {
    title: 'Retrofits',
    subtitle: 'Choose retrofits to augment character behavior',
    icon: Zap,
  },
}

interface PackGroup {
  packId: string
  packName: string
  items: LoomItem[]
}

export default function LoomSelector({ category, onClose }: LoomSelectorProps) {
  const packs = useStore((s) => s.packs)
  const packsWithItems = useStore((s) => s.packsWithItems)
  const setPackWithItems = useStore((s) => s.setPackWithItems)

  const selectedLoomStyles = useStore((s) => s.selectedLoomStyles)
  const selectedLoomUtils = useStore((s) => s.selectedLoomUtils)
  const selectedLoomRetrofits = useStore((s) => s.selectedLoomRetrofits)
  const setSelectedLoomStyles = useStore((s) => s.setSelectedLoomStyles)
  const setSelectedLoomUtils = useStore((s) => s.setSelectedLoomUtils)
  const setSelectedLoomRetrofits = useStore((s) => s.setSelectedLoomRetrofits)

  const [searchTerm, setSearchTerm] = useState('')
  const [loadingPacks, setLoadingPacks] = useState(false)
  const [collapsedPacks, setCollapsedPacks] = useState<Set<string>>(new Set())

  const config = CATEGORY_CONFIG[category]

  // Get the correct selection array and setter for this category
  const { selected, setSelected } = useMemo(() => {
    if (category === 'narrative_style') return { selected: selectedLoomStyles, setSelected: setSelectedLoomStyles }
    if (category === 'loom_utility') return { selected: selectedLoomUtils, setSelected: setSelectedLoomUtils }
    return { selected: selectedLoomRetrofits, setSelected: setSelectedLoomRetrofits }
  }, [category, selectedLoomStyles, selectedLoomUtils, selectedLoomRetrofits,
      setSelectedLoomStyles, setSelectedLoomUtils, setSelectedLoomRetrofits])

  // Load all packs' items
  useEffect(() => {
    const unloaded = packs.filter((p) => !packsWithItems[p.id])
    if (unloaded.length === 0) return
    setLoadingPacks(true)
    Promise.all(
      unloaded.map((p) =>
        packsApi.get(p.id).then((data) => setPackWithItems(p.id, data)).catch(() => {})
      )
    ).finally(() => setLoadingPacks(false))
  }, [packs, packsWithItems, setPackWithItems])

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handler)
      document.body.style.overflow = ''
    }
  }, [onClose])

  // Build groups of loom items by pack, filtered by category
  const packGroups = useMemo(() => {
    const groups: PackGroup[] = []
    const query = searchTerm.toLowerCase().trim()

    for (const pack of packs) {
      const loaded = packsWithItems[pack.id] as PackWithItems | undefined
      if (!loaded?.loom_items?.length) continue

      const filtered = loaded.loom_items.filter((item) => {
        if (item.category !== category) return false
        if (query && !item.name.toLowerCase().includes(query)) return false
        return true
      })

      if (filtered.length > 0) {
        groups.push({ packId: pack.id, packName: pack.name, items: filtered })
      }
    }
    return groups
  }, [packs, packsWithItems, category, searchTerm])

  const selectedIds = useMemo(() => new Set(selected.map((s) => s.id)), [selected])
  const selectedCount = selectedIds.size

  const handleToggleItem = useCallback((item: LoomItem) => {
    const isSelected = selectedIds.has(item.id)
    if (isSelected) {
      setSelected(selected.filter((s) => s.id !== item.id))
    } else {
      setSelected([...selected, item])
    }
  }, [selected, selectedIds, setSelected])

  const handleClearAll = useCallback(() => setSelected([]), [setSelected])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose() },
    [onClose]
  )

  const togglePack = useCallback((packId: string) => {
    setCollapsedPacks((prev) => {
      const next = new Set(prev)
      if (next.has(packId)) next.delete(packId)
      else next.add(packId)
      return next
    })
  }, [])

  const collapseAll = useCallback(() => {
    setCollapsedPacks(new Set(packGroups.map((g) => g.packId)))
  }, [packGroups])

  const expandAll = useCallback(() => setCollapsedPacks(new Set()), [])

  const Icon = config.icon

  const content = (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerIcon}><Icon size={20} /></div>
          <div className={styles.headerText}>
            <h3 className={styles.title}>{config.title}</h3>
            <p className={styles.subtitle}>{config.subtitle}</p>
          </div>
          {selectedCount > 0 && (
            <button className={styles.clearBtn} onClick={handleClearAll} title="Clear all">
              <XCircle size={14} />
              Clear ({selectedCount})
            </button>
          )}
          <button className={styles.closeBtn} onClick={onClose} title="Close">
            <X size={20} />
          </button>
        </div>

        {/* Search + controls */}
        <div className={styles.controls}>
          <div className={styles.searchBox}>
            <Search size={14} />
            <input
              type="text"
              className={styles.searchInput}
              placeholder={`Search ${config.title.toLowerCase()}...`}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button className={styles.searchClear} onClick={() => setSearchTerm('')}>
                <XCircle size={14} />
              </button>
            )}
          </div>
          {packGroups.length > 1 && (
            <div className={styles.controlBtns}>
              <button className={styles.controlBtn} onClick={expandAll}>
                <ChevronDown size={12} /> Expand
              </button>
              <button className={styles.controlBtn} onClick={collapseAll}>
                <ChevronUp size={12} /> Collapse
              </button>
            </div>
          )}
        </div>

        {/* Content */}
        <div className={styles.scrollArea}>
          {loadingPacks ? (
            <div className={styles.empty}>Loading packs...</div>
          ) : packGroups.length === 0 ? (
            <div className={styles.empty}>
              {searchTerm
                ? 'No matching items found.'
                : `No ${config.title.toLowerCase()} available. Import packs in the Browser tab.`}
            </div>
          ) : (
            packGroups.map((group) => (
              <div key={group.packId} className={styles.packSection}>
                <button
                  className={styles.packHeader}
                  onClick={() => togglePack(group.packId)}
                >
                  <ChevronDown
                    size={14}
                    className={clsx(styles.packChevron, collapsedPacks.has(group.packId) && styles.packChevronCollapsed)}
                  />
                  <span className={styles.packName}>{group.packName}</span>
                  <span className={styles.packCount}>{group.items.length}</span>
                </button>
                {!collapsedPacks.has(group.packId) && (
                  <div className={styles.itemsList}>
                    {group.items.map((item) => {
                      const isSelected = selectedIds.has(item.id)
                      return (
                        <button
                          key={item.id}
                          className={clsx(styles.item, isSelected && styles.itemSelected)}
                          onClick={() => handleToggleItem(item)}
                        >
                          <div className={styles.itemContent}>
                            <span className={styles.itemName}>{item.name}</span>
                            {item.author_name && (
                              <span className={styles.itemAuthor}>by {item.author_name}</span>
                            )}
                          </div>
                          <div className={clsx(styles.toggle, isSelected && styles.toggleOn)}>
                            <div className={styles.toggleThumb} />
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <span className={styles.footerCount}>
            {selectedCount} selected
          </span>
          <button className={styles.doneBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )

  return createPortal(content, document.body)
}
