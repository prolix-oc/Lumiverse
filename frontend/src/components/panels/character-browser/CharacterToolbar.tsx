import {
  Search,
  X,
  Users,
  Star,
  LayoutGrid,
  Columns2,
  List,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  CheckSquare,
  Layers,
  UsersRound,
} from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
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
  onImportUrl: () => void
  onCreateNew: () => void
  importLoading: boolean
  onGroupChat?: () => void
}

const SORT_OPTIONS: { value: CharacterSortField; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'recent', label: 'Recent' },
  { value: 'created', label: 'Created' },
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
  onImportUrl,
  onCreateNew,
  importLoading,
  onGroupChat,
}: CharacterToolbarProps) {
  const [sortOpen, setSortOpen] = useState(false)
  const sortRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sortOpen) return
    const handler = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [sortOpen])

  return (
    <div className={styles.toolbar}>
      {/* Search bar */}
      <div className={styles.searchBar}>
        <Search size={14} className={styles.searchIcon} />
        <input
          type="text"
          className={styles.searchInput}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search characters..."
        />
        {searchQuery && (
          <button type="button" className={styles.clearBtn} onClick={() => onSearchChange('')}>
            <X size={14} />
          </button>
        )}
      </div>

      {/* Controls row */}
      <div className={styles.controls}>
        {/* Filter tabs */}
        <div className={styles.filterTabs}>
          <button
            type="button"
            className={clsx(styles.tabBtn, filterTab === 'all' && styles.tabBtnActive)}
            onClick={() => onFilterTabChange('all')}
            title="All"
          >
            <Layers size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.tabBtn, filterTab === 'characters' && styles.tabBtnActive)}
            onClick={() => onFilterTabChange('characters')}
            title="Characters"
          >
            <Users size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.tabBtn, filterTab === 'favorites' && styles.tabBtnActive)}
            onClick={() => onFilterTabChange('favorites')}
            title="Favorites"
          >
            <Star size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.tabBtn, filterTab === 'groups' && styles.tabBtnActive)}
            onClick={() => onFilterTabChange('groups')}
            title="Group Chats"
          >
            <UsersRound size={14} />
          </button>
        </div>

        {/* Sort */}
        <div className={styles.sortContainer} ref={sortRef}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setSortOpen(!sortOpen)}
            title={`Sort by ${sortField}`}
          >
            <ArrowUpDown size={14} />
          </button>
          {sortOpen && (
            <div className={styles.sortDropdown}>
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={clsx(styles.sortItem, sortField === opt.value && styles.sortItemActive)}
                  onClick={() => {
                    onSortFieldChange(opt.value)
                    setSortOpen(false)
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onToggleSortDirection}
            title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
          >
            {sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
          </button>
        </div>

        {/* View mode */}
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => {
            const next = viewMode === 'grid' ? 'columns' : viewMode === 'columns' ? 'list' : 'grid'
            onViewModeChange(next)
          }}
          title={
            viewMode === 'grid'
              ? 'Switch to two-column view'
              : viewMode === 'columns'
                ? 'Switch to list view'
                : 'Switch to grid view'
          }
        >
          {viewMode === 'grid' ? <Columns2 size={14} /> : viewMode === 'columns' ? <List size={14} /> : <LayoutGrid size={14} />}
        </button>

        {/* Import */}
        <ImportMenu
          onImportFile={onImportFile}
          onImportUrl={onImportUrl}
          onCreateNew={onCreateNew}
          importLoading={importLoading}
        />

        {/* Group Chat */}
        {onGroupChat && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onGroupChat}
            title="New Group Chat"
          >
            <UsersRound size={14} />
          </button>
        )}

        {/* Batch mode */}
        <button
          type="button"
          className={clsx(styles.iconBtn, batchMode && styles.iconBtnActive)}
          onClick={() => onBatchModeChange(!batchMode)}
          title={batchMode ? 'Exit batch mode' : 'Batch select'}
        >
          <CheckSquare size={14} />
        </button>
      </div>
    </div>
  )
}
