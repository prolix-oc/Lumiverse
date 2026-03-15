import { useState, useMemo, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Search, X, XCircle, ChevronDown, ChevronUp, Check, User, Wrench, Sparkles } from 'lucide-react'
import type { LumiaItem, PackWithItems } from '@/types/api'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import LazyImage from '@/components/shared/LazyImage'
import styles from './LumiaSelector.module.css'
import clsx from 'clsx'

type LumiaMode = 'definition' | 'behavior' | 'personality'

interface LumiaSelectorProps {
  mode: LumiaMode
  onClose: () => void
}

const MODE_CONFIG = {
  definition: {
    title: 'Select Definition',
    subtitle: 'Choose the physical form for your Lumia',
    icon: User,
    field: 'definition' as const,
  },
  behavior: {
    title: 'Select Behaviors',
    subtitle: 'Choose behavioral traits for your Lumia',
    icon: Wrench,
    field: 'behavior' as const,
  },
  personality: {
    title: 'Select Personalities',
    subtitle: 'Choose personality traits for your Lumia',
    icon: Sparkles,
    field: 'personality' as const,
  },
}

interface PackGroup {
  packId: string
  packName: string
  items: LumiaItem[]
}

export default function LumiaSelector({ mode, onClose }: LumiaSelectorProps) {
  const packs = useStore((s) => s.packs)
  const packsWithItems = useStore((s) => s.packsWithItems)
  const setPackWithItems = useStore((s) => s.setPackWithItems)
  const chimeraMode = useStore((s) => s.chimeraMode)

  const selectedDefinition = useStore((s) => s.selectedDefinition)
  const selectedBehaviors = useStore((s) => s.selectedBehaviors)
  const selectedPersonalities = useStore((s) => s.selectedPersonalities)
  const setSelectedDefinition = useStore((s) => s.setSelectedDefinition)
  const setSelectedBehaviors = useStore((s) => s.setSelectedBehaviors)
  const setSelectedPersonalities = useStore((s) => s.setSelectedPersonalities)

  const [searchTerm, setSearchTerm] = useState('')
  const [loadingPacks, setLoadingPacks] = useState(false)
  const [collapsedPacks, setCollapsedPacks] = useState<Set<string>>(new Set())

  const config = MODE_CONFIG[mode]
  const isMultiSelect = mode !== 'definition' || chimeraMode
  const titleOverride = mode === 'definition' && chimeraMode ? 'Select Chimera Forms' : config.title
  const subtitleOverride = mode === 'definition' && chimeraMode
    ? 'Choose multiple physical forms to fuse into a Chimera'
    : config.subtitle

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

  // Build groups of items by pack, filtered by mode (only items that have content for the field)
  const packGroups = useMemo(() => {
    const groups: PackGroup[] = []
    const query = searchTerm.toLowerCase().trim()

    for (const pack of packs) {
      const loaded = packsWithItems[pack.id] as PackWithItems | undefined
      if (!loaded?.lumia_items?.length) continue

      const filtered = loaded.lumia_items.filter((item) => {
        // Only show items that have content for this mode's field
        if (mode === 'definition' && !item.definition) return false
        if (mode === 'behavior' && !item.behavior) return false
        if (mode === 'personality' && !item.personality) return false
        if (query && !item.name.toLowerCase().includes(query)) return false
        return true
      })

      if (filtered.length > 0) {
        groups.push({ packId: pack.id, packName: pack.name, items: filtered })
      }
    }
    return groups
  }, [packs, packsWithItems, mode, searchTerm])

  // Get current selection
  const selectedIds = useMemo(() => {
    const set = new Set<string>()
    if (mode === 'definition') {
      if (selectedDefinition) set.add(selectedDefinition.id)
    } else if (mode === 'behavior') {
      selectedBehaviors.forEach((b) => set.add(b.id))
    } else {
      selectedPersonalities.forEach((p) => set.add(p.id))
    }
    return set
  }, [mode, selectedDefinition, selectedBehaviors, selectedPersonalities])

  const selectedCount = selectedIds.size

  const handleToggleItem = useCallback((item: LumiaItem) => {
    if (mode === 'definition') {
      if (isMultiSelect) {
        // Chimera mode: toggle in the behaviors array (chimera uses behaviors for fused defs)
        const isSelected = selectedIds.has(item.id)
        if (isSelected) {
          if (selectedDefinition?.id === item.id) {
            setSelectedDefinition(null)
          }
        } else {
          if (!selectedDefinition) {
            setSelectedDefinition(item)
          }
        }
        // For chimera, we actually still use selectedDefinition for primary
        // But the backend chimera reads behaviors for the fused items
        // Let's keep it simple: single select toggles the definition
        const current = selectedDefinition
        if (current?.id === item.id) {
          setSelectedDefinition(null)
        } else {
          setSelectedDefinition(item)
        }
      } else {
        // Single select
        if (selectedDefinition?.id === item.id) {
          setSelectedDefinition(null)
        } else {
          setSelectedDefinition(item)
        }
      }
    } else if (mode === 'behavior') {
      const isSelected = selectedBehaviors.some((b) => b.id === item.id)
      if (isSelected) {
        setSelectedBehaviors(selectedBehaviors.filter((b) => b.id !== item.id))
      } else {
        setSelectedBehaviors([...selectedBehaviors, item])
      }
    } else {
      const isSelected = selectedPersonalities.some((p) => p.id === item.id)
      if (isSelected) {
        setSelectedPersonalities(selectedPersonalities.filter((p) => p.id !== item.id))
      } else {
        setSelectedPersonalities([...selectedPersonalities, item])
      }
    }
  }, [mode, isMultiSelect, selectedDefinition, selectedBehaviors, selectedPersonalities,
      setSelectedDefinition, setSelectedBehaviors, setSelectedPersonalities, selectedIds])

  const handleClearAll = useCallback(() => {
    if (mode === 'definition') setSelectedDefinition(null)
    else if (mode === 'behavior') setSelectedBehaviors([])
    else setSelectedPersonalities([])
  }, [mode, setSelectedDefinition, setSelectedBehaviors, setSelectedPersonalities])

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
            <h3 className={styles.title}>{titleOverride}</h3>
            <p className={styles.subtitle}>{subtitleOverride}</p>
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
              placeholder={`Search ${config.title.replace('Select ', '').toLowerCase()}...`}
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
              {searchTerm ? 'No matching items found.' : 'No Lumia items available. Import packs in the Browser tab.'}
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
                  <div className={styles.cardGrid}>
                    {group.items.map((item) => {
                      const isSelected = selectedIds.has(item.id)
                      return (
                        <button
                          key={item.id}
                          className={clsx(styles.card, isSelected && styles.cardSelected)}
                          onClick={() => handleToggleItem(item)}
                        >
                          <div className={styles.cardImage}>
                            {item.avatar_url ? (
                              <LazyImage
                                src={item.avatar_url}
                                alt={item.name}
                                className={styles.cardImg}
                                fallback={<div className={styles.cardPlaceholder}>{item.name[0]}</div>}
                                spinnerSize={16}
                              />
                            ) : (
                              <div className={styles.cardPlaceholder}>{item.name[0]}</div>
                            )}
                            <div className={clsx(styles.cardCheck, isSelected && styles.cardCheckVisible)}>
                              <Check size={12} strokeWidth={3} />
                            </div>
                          </div>
                          <div className={styles.cardName}>{item.name}</div>
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
