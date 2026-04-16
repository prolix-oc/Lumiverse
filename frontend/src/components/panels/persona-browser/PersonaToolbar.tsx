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
  FolderPlus,
  Check,
  RefreshCw,
  Globe,
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
  onCreateFolder: (name: string) => void
  onRefresh: () => void
  onGlobalLibraryClick: () => void
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
  onCreateFolder,
  onRefresh,
  onGlobalLibraryClick,
  filteredCount,
  totalCount,
}: PersonaToolbarProps) {
  const [sortOpen, setSortOpen] = useState(false)
  const [showCreatePopover, setShowCreatePopover] = useState(false)
  const [creatingFolderMode, setCreatingFolderMode] = useState(false)
  const [creatingFolderName, setCreatingFolderName] = useState('')
  const sortRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    if (!showCreatePopover) return
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowCreatePopover(false)
        setCreatingFolderMode(false)
        setCreatingFolderName('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showCreatePopover])

  useEffect(() => {
    if (creatingFolderMode && folderInputRef.current) {
      folderInputRef.current.focus()
    }
  }, [creatingFolderMode])

  const handleConfirmFolder = () => {
    const trimmed = creatingFolderName.trim()
    if (!trimmed) return
    onCreateFolder(trimmed)
    setCreatingFolderMode(false)
    setCreatingFolderName('')
    setShowCreatePopover(false)
  }

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
          placeholder="Search personas..."
        />
        {searchQuery && (
          <button type="button" className={styles.clearBtn} onClick={() => onSearchChange('')}>
            <X size={14} />
          </button>
        )}
        <div className={styles.createPopoverWrapper} ref={popoverRef}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setShowCreatePopover(!showCreatePopover)}
            title="Add"
          >
            <Plus size={14} />
          </button>
          {showCreatePopover && (
            <div className={styles.createPopover}>
              {creatingFolderMode ? (
                <div className={styles.createPopoverInput}>
                  <input
                    ref={folderInputRef}
                    value={creatingFolderName}
                    onChange={(e) => setCreatingFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleConfirmFolder()
                      if (e.key === 'Escape') {
                        setCreatingFolderMode(false)
                        setCreatingFolderName('')
                      }
                    }}
                    placeholder="Folder name..."
                    className={styles.createPopoverField}
                  />
                  <button
                    className={styles.createPopoverBtn}
                    onClick={handleConfirmFolder}
                    disabled={!creatingFolderName.trim()}
                  >
                    <Check size={12} />
                  </button>
                  <button
                    className={styles.createPopoverBtn}
                    onClick={() => {
                      setCreatingFolderMode(false)
                      setCreatingFolderName('')
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className={styles.createPopoverOption}
                    onClick={() => {
                      onCreateClick()
                      setShowCreatePopover(false)
                    }}
                  >
                    <Plus size={12} /> New Persona
                  </button>
                  <button
                    className={clsx(styles.createPopoverOption, styles.createPopoverFolder)}
                    onClick={() => setCreatingFolderMode(true)}
                  >
                    <FolderPlus size={12} /> New Folder
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Filter + Sort + View + Refresh */}
      <div className={styles.controlRow}>
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

        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => onViewModeChange(viewMode === 'grid' ? 'list' : 'grid')}
          title={viewMode === 'grid' ? 'Switch to list' : 'Switch to grid'}
        >
          {viewMode === 'grid' ? <List size={14} /> : <LayoutGrid size={14} />}
        </button>

        <button
          type="button"
          className={styles.iconBtn}
          onClick={onGlobalLibraryClick}
          title="Global add-ons library"
        >
          <Globe size={14} />
        </button>

        <button
          type="button"
          className={styles.iconBtn}
          onClick={onRefresh}
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>

        <span className={styles.count}>
          {filteredCount}/{totalCount}
        </span>
      </div>
    </div>
  )
}
