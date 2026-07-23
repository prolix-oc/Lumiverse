import {
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
import { SortControl } from '@/components/shared/SortControl'
import SearchField from '@/components/shared/SearchField'

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
  // shuffle is meaningless for group chats; the hook coerces it to 'recent'
  // for fetching — mirror that visually so the active item highlights correctly.
  const effectiveSortField: CharacterSortField =
    isGroupsTab && sortField === 'shuffle' ? 'recent' : sortField
  const visibleSortOptions = isGroupsTab
    ? SORT_OPTIONS.filter((opt) => opt.value !== 'shuffle')
    : SORT_OPTIONS

  return (
    <div className={styles.toolbar}>
      {/* Search bar with create action */}
      <SearchField
        value={searchQuery}
        onChange={onSearchChange}
        placeholder={isGroupsTab ? t('characterToolbar.searchGroupChats') : t('characterToolbar.searchCharacters')}
        clearLabel={t('actions.clear', { ns: 'common' })}
        actions={<ImportMenu
          onImportFile={onImportFile}
          onImportTagLibrary={onImportTagLibrary}
          onImportUrl={onImportUrl}
          onCreateNew={onCreateNew}
          onCreateFolder={onCreateFolder}
          importLoading={importLoading}
          tagLibraryImporting={tagLibraryImporting}
        />}
      />

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
