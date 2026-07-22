import {
  Search,
  X,
  Star,
  LayoutGrid,
  RectangleVertical,
  List,
  RefreshCw,
  CheckSquare,
  Layers,
  UsersRound,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ImportMenu from './ImportMenu'
import type { CharacterFilterTab, CharacterSortField, CharacterSortDirection, CharacterViewMode } from '@/types/store'
import styles from './CharacterToolbar.module.css'
import clsx from 'clsx'
import { clearSearchOnEscape } from '@/lib/clearableSearch'
import { SortControl } from '@/components/shared/SortControl'
import { isGroupCharacterSortField } from '@/lib/characterSort'

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
  onCreateFolder: (name: string) => void
  importLoading: boolean
  tagLibraryImporting?: boolean
  onGroupChat?: () => void
}

const SORT_OPTIONS: { value: CharacterSortField; label: string }[] = [
  { value: 'name', label: 'name' },
  { value: 'recent', label: 'recent' },
  { value: 'created', label: 'created' },
  { value: 'author', label: 'author' },
  { value: 'tokens', label: 'tokens' },
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
  onCreateFolder,
  importLoading,
  tagLibraryImporting = false,
  onGroupChat,
}: CharacterToolbarProps) {
  const { t } = useTranslation('panels')
  const isGroupsTab = filterTab === 'groups'
  // Character-only fields are meaningless for group chats; the hook coerces
  // them to 'recent' for fetching — mirror that visually here.
  const effectiveSortField: CharacterSortField =
    isGroupsTab && !isGroupCharacterSortField(sortField) ? 'recent' : sortField
  const visibleSortOptions = isGroupsTab
    ? SORT_OPTIONS.filter((opt) => isGroupCharacterSortField(opt.value))
    : SORT_OPTIONS

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
          onKeyDown={(e) => clearSearchOnEscape(e, searchQuery, () => onSearchChange(''))}
          placeholder={isGroupsTab ? t('characterToolbar.searchGroupChats') : t('characterToolbar.searchCharacters')}
        />
        {searchQuery && (
          <button type="button" className={styles.clearBtn} onClick={() => onSearchChange('')} aria-label={t('actions.clear', { ns: 'common' })}>
            <X size={14} />
          </button>
        )}
        <ImportMenu
          onImportFile={onImportFile}
          onImportTagLibrary={onImportTagLibrary}
          onImportUrl={onImportUrl}
          onCreateNew={onCreateNew}
          onCreateFolder={onCreateFolder}
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

        <SortControl
          options={visibleSortOptions.map((option) => ({
            value: option.value,
            label: t(`characterToolbar.sort.${option.label}`),
          }))}
          value={effectiveSortField}
          onChange={onSortFieldChange}
          title={t('characterToolbar.sortBy', { field: t(`characterToolbar.sort.${effectiveSortField}`) })}
          {...(effectiveSortField === 'shuffle'
            ? undefined
            : {
                direction: sortDirection,
                onToggleDirection: onToggleSortDirection,
                ascendingTitle: t('characterToolbar.ascending'),
                descendingTitle: t('characterToolbar.descending'),
              })}
        />
        {effectiveSortField === 'shuffle' && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onToggleSortDirection}
            title={t('characterToolbar.reshuffle')}
          >
            <RefreshCw size={14} />
          </button>
        )}

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
