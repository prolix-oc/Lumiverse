import {
  Search,
  X,
  Layers,
  Crown,
  Link2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  LayoutGrid,
  List,
  Plus,
  RefreshCw,
} from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import type { PersonaFilterType, PersonaSortField, PersonaSortDirection, PersonaViewMode } from '@/types/store'
import styles from './PersonaToolbar.module.css'
import clsx from 'clsx'

interface PersonaToolbarProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  filterType: PersonaFilterType
  onFilterTypeChange: (type: PersonaFilterType) => void
  sortField: PersonaSortField
  onSortFieldChange: (field: PersonaSortField) => void
  sortDirection: PersonaSortDirection
  onToggleSortDirection: () => void
  viewMode: PersonaViewMode
  onViewModeChange: (mode: PersonaViewMode) => void
  onCreateClick: () => void
  onRefresh: () => void
  filteredCount: number
  totalCount: number
}

const SORT_OPTIONS: { value: PersonaSortField; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'created', label: 'Created' },
]

export default function PersonaToolbar({
  searchQuery,
  onSearchChange,
  filterType,
  onFilterTypeChange,
  sortField,
  onSortFieldChange,
  sortDirection,
  onToggleSortDirection,
  viewMode,
  onViewModeChange,
  onCreateClick,
  onRefresh,
  filteredCount,
  totalCount,
}: PersonaToolbarProps) {
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
          placeholder="Search personas..."
        />
        {searchQuery && (
          <button type="button" className={styles.clearBtn} onClick={() => onSearchChange('')}>
            <X size={14} />
          </button>
        )}
      </div>

      {/* Controls row */}
      <div className={styles.controls}>
        {/* Filter pills */}
        <div className={styles.filterTabs}>
          <button
            type="button"
            className={clsx(styles.tabBtn, filterType === 'all' && styles.tabBtnActive)}
            onClick={() => onFilterTypeChange('all')}
            title="All"
          >
            <Layers size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.tabBtn, filterType === 'default' && styles.tabBtnActive)}
            onClick={() => onFilterTypeChange('default')}
            title="Default"
          >
            <Crown size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.tabBtn, filterType === 'connected' && styles.tabBtnActive)}
            onClick={() => onFilterTypeChange('connected')}
            title="Connected"
          >
            <Link2 size={14} />
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
          onClick={() => onViewModeChange(viewMode === 'grid' ? 'list' : 'grid')}
          title={viewMode === 'grid' ? 'Switch to list' : 'Switch to grid'}
        >
          {viewMode === 'grid' ? <List size={14} /> : <LayoutGrid size={14} />}
        </button>

        {/* Create */}
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onCreateClick}
          title="New persona"
        >
          <Plus size={14} />
        </button>

        {/* Refresh */}
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onRefresh}
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>

        {/* Count */}
        <span className={styles.count}>
          {filteredCount}/{totalCount}
        </span>
      </div>
    </div>
  )
}
