import {
  Search,
  X,
  Star,
  LayoutGrid,
  RectangleVertical,
  List,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  CheckSquare,
  Layers,
  UsersRound,
} from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import ImportMenu from './ImportMenu'
import type { CharacterFilterTab, CharacterSortField, CharacterSortDirection, CharacterViewMode } from '@/types/store'
import styles from './CharacterToolbar.module.css'
import clsx from 'clsx'

interface CharacterToolbarProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  filterTab: CharacterFilterTab
  onFilterTabChange: (tab: CharacterFilterTab) => void
  sortField: CharacterSortField
  onSortFieldChange: (field: CharacterSortField) => void
  sortDirection: CharacterSortDirection
  onToggleSortDirection: () => void
  viewMode: CharacterViewMode
  onViewModeChange: (mode: CharacterViewMode) => void
  batchMode: boolean
  onBatchModeChange: (enabled: boolean) => void
  onImportFile: (files: File[]) => void
  onImportTagLibrary: (file: File) => void
  onImportUrl: () => void
  onCreateNew: () => void
  importLoading: boolean
  tagLibraryImporting?: boolean
  onGroupChat?: () => void
}

const SORT_OPTIONS: { value: CharacterSortField; label: string }[] = [
  { value: 'name', label: 'name' },
  { value: 'recent', label: 'recent' },
  { value: 'created', label: 'created' },
  { value: 'shuffle', label: 'shuffle' },
]

export default function CharacterToolbar({
  searchQuery,
  onSearchChange,
  filterTab,
  onFilterTabChange,
  sortField,
  onSortFieldChange,
  sortDirection,
  onToggleSortDirection,
  viewMode,
  onViewModeChange,
  batchMode,
  onBatchModeChange,
  onImportFile,
  onImportTagLibrary,
  onImportUrl,
  onCreateNew,
  importLoading,
  tagLibraryImporting = false,
  onGroupChat,
}: CharacterToolbarProps) {
  const { t } = useTranslation('panels')
  const [sortOpen, setSortOpen] = useState(false)
  const sortRef = useRef<HTMLDivElement>(null)

  const isGroupsTab = filterTab === 'groups'
  // shuffle is meaningless for group chats; the hook coerces it to 'recent'
  // for fetching — mirror that visually so the active item highlights correctly.
  const effectiveSortField: CharacterSortField =
    isGroupsTab && sortField === 'shuffle' ? 'recent' : sortField
  const visibleSortOptions = isGroupsTab
    ? SORT_OPTIONS.filter((opt) => opt.value !== 'shuffle')
    : SORT_OPTIONS

  useEffect(() => {
    if (!sortOpen) return
    const openedAt = Date.now()
    const handler = (e: PointerEvent) => {
      if (e.timeStamp < openedAt + 100) return
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false)
      }
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [sortOpen])

  return (
    <div className={styles.toolbar}>
      {/* Search bar with create action */}
      <div className={styles.searchBar}>
        <Search size={14} className={styles.searchIcon} />
        <input
          type="text"
          className={styles.searchInput}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={isGroupsTab ? t('characterToolbar.searchGroupChats') : t('characterToolbar.searchCharacters')}
        />
        {searchQuery && (
          <button type="button" className={styles.clearBtn} onClick={() => onSearchChange('')}>
            <X size={14} />
          </button>
        )}
        <ImportMenu
          onImportFile={onImportFile}
          onImportTagLibrary={onImportTagLibrary}
          onImportUrl={onImportUrl}
          onCreateNew={onCreateNew}
          importLoading={importLoading}
          tagLibraryImporting={tagLibraryImporting}
        />
      </div>

      {/* Filter + Sort + View + Actions — single row */}
      <div className={styles.controlRow}>
        <div className={styles.filterTabs}>
          <button
            type="button"
            className={clsx(styles.tabBtn, filterTab === 'characters' && styles.tabBtnActive)}
            onClick={() => onFilterTabChange('characters')}
            title={t('characterToolbar.characters')}
          >
            <Layers size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.tabBtn, filterTab === 'favorites' && styles.tabBtnActive)}
            onClick={() => onFilterTabChange('favorites')}
            title={t('characterToolbar.favorites')}
          >
            <Star size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.tabBtn, filterTab === 'groups' && styles.tabBtnActive)}
            onClick={() => onFilterTabChange('groups')}
            title={t('characterToolbar.groupChats')}
          >
            <UsersRound size={14} />
          </button>
        </div>

        <div className={styles.sortContainer} ref={sortRef}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setSortOpen(!sortOpen)}
            title={t('characterToolbar.sortBy', { field: t(`characterToolbar.sort.${effectiveSortField}`) })}
          >
            <ArrowUpDown size={14} />
          </button>
          {sortOpen && (
            <div className={styles.sortDropdown}>
              {visibleSortOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={clsx(styles.sortItem, effectiveSortField === opt.value && styles.sortItemActive)}
                  onClick={() => {
                    onSortFieldChange(opt.value)
                    setSortOpen(false)
                  }}
                >
                  {t(`characterToolbar.sort.${opt.label}`)}
                </button>
              ))}
            </div>
          )}
          {effectiveSortField === 'shuffle' ? (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onToggleSortDirection}
              title={t('characterToolbar.reshuffle')}
            >
              <RefreshCw size={14} />
            </button>
          ) : (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onToggleSortDirection}
              title={sortDirection === 'asc' ? t('characterToolbar.ascending') : t('characterToolbar.descending')}
            >
              {sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
            </button>
          )}
        </div>

        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => {
            const next = viewMode === 'grid' ? 'single' : viewMode === 'single' ? 'list' : 'grid'
            onViewModeChange(next)
          }}
          title={
            viewMode === 'grid'
              ? t('characterToolbar.switchToSingle')
              : viewMode === 'single'
                ? t('characterToolbar.switchToList')
                : t('characterToolbar.switchToGrid')
          }
        >
          {viewMode === 'grid' ? <RectangleVertical size={14} /> : viewMode === 'single' ? <List size={14} /> : <LayoutGrid size={14} />}
        </button>

        {onGroupChat && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onGroupChat}
            title={t('characterToolbar.newGroupChat')}
          >
            <UsersRound size={14} />
          </button>
        )}

        <button
          type="button"
          className={clsx(styles.iconBtn, batchMode && styles.iconBtnActive)}
          onClick={() => onBatchModeChange(!batchMode)}
          title={batchMode ? t('characterToolbar.exitBatchMode') : t('characterToolbar.batchSelect')}
        >
          <CheckSquare size={14} />
        </button>
      </div>
    </div>
  )
}
