import { useState, useMemo, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, XCircle, ChevronDown, ChevronUp, Check, User, Sparkles } from 'lucide-react'
import { IconAdjustments } from '@tabler/icons-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import type { LumiaItem, PackWithItems } from '@/types/api'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import LazyImage from '@/components/shared/LazyImage'
import styles from './LumiaSelector.module.css'
import clsx from 'clsx'
import { clearSearchOnEscape } from '@/lib/clearableSearch'

type LumiaMode = 'definition' | 'behavior' | 'personality'

interface LumiaSelectorProps {
  mode: LumiaMode
  onClose: () => void
}

const MODE_ICONS = {
  definition: User,
  behavior: IconAdjustments,
  personality: Sparkles,
} as const

interface PackGroup {
  packId: string
  packName: string
  items: LumiaItem[]
}

export default function LumiaSelector({ mode, onClose }: LumiaSelectorProps) {
  const { t } = useTranslation('modals', { keyPrefix: 'lumiaSelector' })
  const { t: tc } = useTranslation('common')

  const packs = useStore((s) => s.packs)
  const packsWithItems = useStore((s) => s.packsWithItems)
  const setPackWithItems = useStore((s) => s.setPackWithItems)
  const chimeraMode = useStore((s) => s.chimeraMode)

  const selectedDefinition = useStore((s) => s.selectedDefinition)
  const selectedChimeraDefinitions = useStore((s) => s.selectedChimeraDefinitions)
  const selectedBehaviors = useStore((s) => s.selectedBehaviors)
  const selectedPersonalities = useStore((s) => s.selectedPersonalities)
  const setSelectedDefinition = useStore((s) => s.setSelectedDefinition)
  const setSelectedChimeraDefinitions = useStore((s) => s.setSelectedChimeraDefinitions)
  const setSelectedBehaviors = useStore((s) => s.setSelectedBehaviors)
  const setSelectedPersonalities = useStore((s) => s.setSelectedPersonalities)

  const [searchTerm, setSearchTerm] = useState('')
  const [loadingPacks, setLoadingPacks] = useState(false)
  const [collapsedPacks, setCollapsedPacks] = useState<Set<string>>(new Set())

  const modeTitle = mode === 'definition'
    ? t('definitionTitle')
    : mode === 'behavior'
      ? t('behaviorTitle')
      : t('personalityTitle')
  const modeSubtitle = mode === 'definition'
    ? t('definitionSubtitle')
    : mode === 'behavior'
      ? t('behaviorSubtitle')
      : t('personalitySubtitle')
  const isMultiSelect = mode === 'definition' ? chimeraMode : !chimeraMode
  const titleOverride = mode === 'definition' && chimeraMode ? t('chimeraDefinitionTitle') : modeTitle
  const subtitleOverride = useMemo(() => {
    if (mode === 'definition' && chimeraMode) return t('chimeraDefinitionSubtitle')
    if (mode === 'behavior' && chimeraMode) return t('chimeraBehaviorSubtitle')
    if (mode === 'personality' && chimeraMode) return t('chimeraPersonalitySubtitle')
    return modeSubtitle
  }, [mode, chimeraMode, modeSubtitle, t])

  const effectiveChimeraDefinitions = useMemo(() => {
    if (selectedChimeraDefinitions.length > 0) return selectedChimeraDefinitions
    return selectedDefinition ? [selectedDefinition] : []
  }, [selectedChimeraDefinitions, selectedDefinition])

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
      const definitions = chimeraMode ? effectiveChimeraDefinitions : (selectedDefinition ? [selectedDefinition] : [])
      definitions.forEach((item) => set.add(item.id))
    } else if (mode === 'behavior') {
      selectedBehaviors.forEach((b) => set.add(b.id))
    } else {
      selectedPersonalities.forEach((p) => set.add(p.id))
    }
    return set
  }, [mode, chimeraMode, effectiveChimeraDefinitions, selectedDefinition, selectedBehaviors, selectedPersonalities])

  const selectedCount = selectedIds.size

  const handleToggleItem = useCallback((item: LumiaItem) => {
    if (mode === 'definition') {
      if (chimeraMode) {
        const isSelected = effectiveChimeraDefinitions.some((definition) => definition.id === item.id)
        const nextDefinitions = isSelected
          ? effectiveChimeraDefinitions.filter((definition) => definition.id !== item.id)
          : [...effectiveChimeraDefinitions, item]

        setSelectedChimeraDefinitions(nextDefinitions)
        setSelectedDefinition(nextDefinitions[0] ?? null)
      } else {
        const nextDefinition = selectedDefinition?.id === item.id ? null : item
        setSelectedDefinition(nextDefinition)
        setSelectedChimeraDefinitions(nextDefinition ? [nextDefinition] : [])
      }
    } else if (mode === 'behavior') {
      const isSelected = selectedBehaviors.some((behavior) => behavior.id === item.id)
      if (isMultiSelect) {
        if (isSelected) {
          setSelectedBehaviors(selectedBehaviors.filter((behavior) => behavior.id !== item.id))
        } else {
          setSelectedBehaviors([...selectedBehaviors, item])
        }
      } else if (isSelected) {
        setSelectedBehaviors([])
      } else {
        setSelectedBehaviors([item])
      }
    } else {
      const isSelected = selectedPersonalities.some((personality) => personality.id === item.id)
      if (isMultiSelect) {
        if (isSelected) {
          setSelectedPersonalities(selectedPersonalities.filter((personality) => personality.id !== item.id))
        } else {
          setSelectedPersonalities([...selectedPersonalities, item])
        }
      } else if (isSelected) {
        setSelectedPersonalities([])
      } else {
        setSelectedPersonalities([item])
      }
    }
  }, [
    mode,
    chimeraMode,
    isMultiSelect,
    selectedDefinition,
    effectiveChimeraDefinitions,
    selectedBehaviors,
    selectedPersonalities,
    setSelectedDefinition,
    setSelectedChimeraDefinitions,
    setSelectedBehaviors,
    setSelectedPersonalities,
  ])

  const handleClearAll = useCallback(() => {
    if (mode === 'definition') {
      setSelectedDefinition(null)
      setSelectedChimeraDefinitions([])
    }
    else if (mode === 'behavior') setSelectedBehaviors([])
    else setSelectedPersonalities([])
  }, [mode, setSelectedDefinition, setSelectedChimeraDefinitions, setSelectedBehaviors, setSelectedPersonalities])

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

  const Icon = MODE_ICONS[mode]

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={600} className={styles.modal}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerIcon}><Icon size={20} /></div>
        <div className={styles.headerText}>
          <h3 className={styles.title}>{titleOverride}</h3>
          <p className={styles.subtitle}>{subtitleOverride}</p>
        </div>
        {selectedCount > 0 && (
          <button className={styles.clearBtn} onClick={handleClearAll} title={t('clearAll')}>
            <XCircle size={14} />
            {t('clearCount', { count: selectedCount })}
          </button>
        )}
        <CloseButton onClick={onClose} iconSize={20} />
      </div>

      {/* Search + controls */}
      <div className={styles.controls}>
        <div className={styles.searchBox}>
          <Search size={14} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder={t('searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => clearSearchOnEscape(e, searchTerm, () => setSearchTerm(''))}
          />
          {searchTerm && (
            <button type="button" className={styles.searchClear} onClick={() => setSearchTerm('')} aria-label={tc('actions.clear')}>
              <XCircle size={14} />
            </button>
          )}
        </div>
        {packGroups.length > 1 && (
          <div className={styles.controlBtns}>
            <button className={styles.controlBtn} onClick={expandAll}>
              <ChevronDown size={12} /> {t('expand')}
            </button>
            <button className={styles.controlBtn} onClick={collapseAll}>
              <ChevronUp size={12} /> {t('collapse')}
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className={styles.scrollArea}>
        {loadingPacks ? (
          <div className={styles.empty}>{t('loadingPacks')}</div>
        ) : packGroups.length === 0 ? (
          <div className={styles.empty}>
            {searchTerm ? t('noMatches') : t('noItems')}
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
          {t('selectedCount', { count: selectedCount })}
        </span>
        <button className={styles.doneBtn} onClick={onClose}>{tc('actions.done')}</button>
      </div>
    </ModalShell>
  )
}
