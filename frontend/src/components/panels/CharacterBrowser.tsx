import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Pencil, Trash2, X } from 'lucide-react'
import { useCharacterBrowser } from '@/hooks/useCharacterBrowser'
import { useFolders } from '@/hooks/useFolders'
import { charactersApi } from '@/api/characters'
import { worldBooksApi } from '@/api/world-books'
import { toast } from '@/lib/toast'
import { formatTagLibraryImportToastMessage } from '@/lib/tagLibraryImportToast'
import { useStore } from '@/store'
import CharacterToolbar from './character-browser/CharacterToolbar'
import TagFilter from './character-browser/TagFilter'
import BatchBar from './character-browser/BatchBar'
import FavoritesSlider from './character-browser/FavoritesSlider'
import CharacterGrid from './character-browser/CharacterGrid'
import CharacterList from './character-browser/CharacterList'
import ImportUrlModal from './character-browser/ImportUrlModal'
import BulkTagsModal from './character-browser/BulkTagsModal'
import DragDropOverlay from './character-browser/DragDropOverlay'
import GroupChatsPanel from './character-browser/GroupChatsPanel'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import BulkImportProgressModal from '@/components/modals/BulkImportProgressModal'
import LorebookImportModal from '@/components/modals/LorebookImportModal'
import ExpressionsImportModal from '@/components/modals/ExpressionsImportModal'
import AlternateFieldsSummaryModal from '@/components/modals/AlternateFieldsSummaryModal'
import Pagination from '@/components/shared/Pagination'
import type { CharacterViewMode } from '@/types/store'
import type { CharacterSummary } from '@/types/api'
import { getEmbeddedCharacterBookEntryCount } from '@/utils/character-world-books'
import styles from './CharacterBrowser.module.css'

function CharacterSkeletons({ viewMode }: { viewMode: CharacterViewMode }) {
  if (viewMode === 'list') {
    return (
      <div className={styles.skeletonList}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className={styles.skeletonRow}>
            <div className={`${styles.skeletonRowAvatar} ${styles.skeletonShimmer}`} style={{ animationDelay: `${i * 0.08}s` }} />
            <div className={styles.skeletonRowText}>
              <div className={`${styles.skeletonRowTitle} ${styles.skeletonShimmer}`} style={{ animationDelay: `${i * 0.08}s` }} />
              <div className={`${styles.skeletonRowSub} ${styles.skeletonShimmer}`} style={{ animationDelay: `${i * 0.08 + 0.1}s` }} />
            </div>
          </div>
        ))}
      </div>
    )
  }

  const d = (i: number, offset = 0) => ({ animationDelay: `${i * 0.08 + offset}s` })

  return (
    <div className={viewMode === 'single' ? styles.skeletonSingle : styles.skeletonGrid}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className={styles.skeletonCard}>
          <div className={`${styles.skeletonCardImage} ${styles.skeletonShimmer}`} style={d(i)} />
          <div className={styles.skeletonCardInfo}>
            <div className={`${styles.skeletonCardName} ${styles.skeletonShimmer}`} style={d(i, 0.04)} />
            <div className={`${styles.skeletonCardCreator} ${styles.skeletonShimmer}`} style={d(i, 0.08)} />
            <div className={styles.skeletonCardTags}>
              <div className={`${styles.skeletonCardTag} ${styles.skeletonShimmer}`} style={d(i, 0.12)} />
              <div className={`${styles.skeletonCardTag} ${styles.skeletonShimmer}`} style={d(i, 0.14)} />
              <div className={`${styles.skeletonCardTag} ${styles.skeletonShimmer}`} style={d(i, 0.16)} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function CharacterBrowser() {
  const { t: ts } = useTranslation('settings')
  const { t } = useTranslation('panels')
  const browser = useCharacterBrowser()
  const setEditingCharacterId = useStore((s) => s.setEditingCharacterId)
  const openModal = useStore((s) => s.openModal)
  const favoritesBarCollapsed = useStore((s) => s.favoritesBarCollapsed)
  const setSetting = useStore((s) => s.setSetting)
  const {
    folders,
    createFolder,
    renameFolder: renameStoredFolder,
    deleteFolder: deleteStoredFolder,
  } = useFolders('characterFolders', browser.allCharacters)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [initializedFolders, setInitializedFolders] = useState(false)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null)
  const [moveBusy, setMoveBusy] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (initializedFolders || browser.groupedCharacters.length === 0) return
    const named = browser.groupedCharacters.map((group) => group.folder).filter(Boolean)
    if (named.length > 0) {
      setCollapsedFolders(new Set(named))
      setInitializedFolders(true)
    }
  }, [browser.groupedCharacters, initializedFolders])

  useEffect(() => {
    if (!renamingFolder) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renamingFolder])

  const toggleFolder = useCallback((folder: string) => {
    setCollapsedFolders((previous) => {
      const next = new Set(previous)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }, [])

  const handleRenameFolder = useCallback(async () => {
    if (!renamingFolder) return
    const oldName = renamingFolder.trim()
    const newName = renamingValue.trim()
    if (!newName) return
    const normalizedNewName = newName.toLocaleLowerCase()
    if (
      normalizedNewName === 'uncategorized'
      || normalizedNewName === t('characterBrowser.uncategorized').trim().toLocaleLowerCase()
    ) return
    if (oldName === newName) {
      setRenamingFolder(null)
      setRenamingValue('')
      return
    }

    setRenameBusy(true)
    try {
      const result = await browser.renameFolder(oldName, newName)
      renameStoredFolder(oldName, newName)
      setCollapsedFolders((previous) => {
        const next = new Set(previous)
        const wasCollapsed = next.delete(oldName)
        if (wasCollapsed) next.add(newName)
        return next
      })
      setRenamingFolder(null)
      setRenamingValue('')
      toast.success(t('characterBrowser.renamedFolderSuccess', { name: newName, count: result.count }))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('characterBrowser.renameFolderFailed'))
    } finally {
      setRenameBusy(false)
    }
  }, [browser, renameStoredFolder, renamingFolder, renamingValue, t])

  const handleDeleteFolder = useCallback((folder: string) => {
    const name = folder.trim()
    if (!name || deletingFolder) return
    openModal('confirm', {
      title: t('characterBrowser.deleteFolderTitle'),
      message: t('characterBrowser.deleteFolderMessage', { name }),
      variant: 'danger',
      confirmText: t('characterBrowser.delete'),
      onConfirm: async () => {
        setDeletingFolder(name)
        try {
          const result = await browser.deleteFolder(name)
          deleteStoredFolder(name)
          setCollapsedFolders((previous) => {
            const next = new Set(previous)
            next.delete(name)
            return next
          })
          toast.success(t('characterBrowser.deletedFolderSuccess', { name, count: result.count }))
        } catch (err: any) {
          toast.error(err?.body?.error || err?.message || t('characterBrowser.deleteFolderFailed'))
        } finally {
          setDeletingFolder(null)
        }
      },
    })
  }, [browser, deleteStoredFolder, deletingFolder, openModal, t])

  const handleMoveCharacters = useCallback(async (folder: string) => {
    if (browser.batchSelected.length === 0) return false
    setMoveBusy(true)
    try {
      const result = await browser.bulkUpdateFolder(browser.batchSelected, folder)
      browser.clearBatchSelection()
      toast.success(t('characterBrowser.movedCharactersSuccess', { count: result.count }))
      return true
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('characterBrowser.moveCharactersFailed'))
      return false
    } finally {
      setMoveBusy(false)
    }
  }, [browser, t])

  const renderCharacterCards = useCallback((characters: CharacterSummary[]) => {
    return browser.viewMode === 'grid' || browser.viewMode === 'single' ? (
      <CharacterGrid
        characters={characters}
        favorites={browser.favorites}
        batchMode={browser.batchMode}
        batchSelected={browser.batchSelected}
        singleColumn={browser.viewMode === 'single'}
        onOpen={browser.openChat}
        onEdit={setEditingCharacterId}
        onToggleFavorite={browser.toggleFavorite}
        onToggleBatch={browser.toggleBatchSelect}
      />
    ) : (
      <CharacterList
        characters={characters}
        favorites={browser.favorites}
        batchMode={browser.batchMode}
        batchSelected={browser.batchSelected}
        onOpen={browser.openChat}
        onEdit={setEditingCharacterId}
        onToggleFavorite={browser.toggleFavorite}
        onToggleBatch={browser.toggleBatchSelect}
      />
    )
  }, [browser, setEditingCharacterId])

  const handleToggleFavoritesCollapse = useCallback(() => {
    setSetting('favoritesBarCollapsed', !favoritesBarCollapsed)
  }, [favoritesBarCollapsed, setSetting])
  const handleCreateNew = useCallback(async () => {
    try {
      const character = await browser.createCharacter()
      setEditingCharacterId(character.id)
    } catch (err) {
      console.error('[CharacterBrowser] Failed to create character:', err)
    }
  }, [browser, setEditingCharacterId])

  const [importUrlOpen, setImportUrlOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [tagLibraryImporting, setTagLibraryImporting] = useState(false)
  const dragCounterRef = useRef(0)

  // Drag and drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setDragging(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setDragging(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        /\.(json|png|charx|jpe?g)$/i.test(f.name)
      )
      if (files.length > 0) {
        browser.importFiles(files)
      }
    },
    [browser]
  )

  const handleBatchDelete = useCallback(() => {
    setConfirmDelete(true)
  }, [])

  const handleImportTagLibrary = useCallback(async (file: File) => {
    setTagLibraryImporting(true)
    try {
      const result = await charactersApi.importTagLibrary(file)
      await browser.reloadAllCharacters()
      toast.success(formatTagLibraryImportToastMessage(ts, result), {
        title: ts('migration.tagLibraryImportComplete'),
        duration: 7000,
      })
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || ts('migration.tagLibraryImportFailed'))
    } finally {
      setTagLibraryImporting(false)
    }
  }, [browser, ts])

  const handleConfirmDelete = useCallback(() => {
    browser.batchDelete()
    setConfirmDelete(false)
  }, [browser])

  const pagination: ReactNode = useMemo(
    () => (
      <Pagination
        currentPage={browser.currentPage}
        totalPages={browser.totalPages}
        onPageChange={browser.setCurrentPage}
        perPage={browser.charactersPerPage}
        perPageOptions={[24, 50, 100, 200, 500]}
        onPerPageChange={browser.setCharactersPerPage}
        totalItems={browser.totalFiltered}
      />
    ),
    [
      browser.currentPage,
      browser.totalPages,
      browser.setCurrentPage,
      browser.charactersPerPage,
      browser.setCharactersPerPage,
      browser.totalFiltered,
    ],
  )

  return (
    <div
      className={styles.browser}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <CharacterToolbar
        searchQuery={browser.searchQuery}
        onSearchChange={browser.setSearchQuery}
        filterTab={browser.filterTab}
        onFilterTabChange={browser.setFilterTab}
        sortField={browser.sortField}
        onSortFieldChange={browser.setSortField}
        sortDirection={browser.sortDirection}
        onToggleSortDirection={browser.toggleSortDirection}
        viewMode={browser.viewMode}
        onViewModeChange={browser.setViewMode}
        batchMode={browser.batchMode}
        onBatchModeChange={browser.setBatchMode}
        onImportFile={browser.importFiles}
        onImportTagLibrary={handleImportTagLibrary}
        onImportUrl={() => setImportUrlOpen(true)}
        onCreateNew={handleCreateNew}
        onCreateFolder={createFolder}
        importLoading={browser.importLoading}
        tagLibraryImporting={tagLibraryImporting}
        onGroupChat={() => openModal('groupChatCreator')}
      />

      <TagFilter
        allTags={browser.allTags}
        selectedTags={browser.selectedTags}
        excludedTags={browser.excludedTags}
        onCycleTag={browser.cycleTagFilter}
        onClearTags={browser.clearTagFilters}
      />

      {browser.batchMode && (
        <BatchBar
          selectedCount={browser.batchSelected.length}
          totalCount={browser.characters.length}
          onSelectAll={() => browser.selectAllBatch(browser.characters.map((c) => c.id))}
          onClearSelection={browser.clearBatchSelection}
          onDelete={handleBatchDelete}
          onTags={() => setBulkTagsOpen(true)}
          folders={folders}
          moveBusy={moveBusy}
          onCreateFolder={createFolder}
          onMove={handleMoveCharacters}
          onCancel={() => browser.setBatchMode(false)}
        />
      )}

      {browser.importProgress && (
        <div className={styles.importProgress}>
          <div className={styles.importProgressSpinner} />
          <div className={styles.importProgressInfo}>
            <div className={styles.importProgressLabel}>
              <span className={styles.importProgressFilename}>{browser.importProgress.filename}</span>
              <span className={styles.importProgressStep}>
                {browser.importProgress.step === 'uploading'
                  ? t('characterBrowser.uploading', { percent: browser.importProgress.percent })
                  : browser.importProgress.step === 'gallery'
                    ? t('characterBrowser.addingToGallery', {
                        current: browser.importProgress.galleryCurrent,
                        total: browser.importProgress.galleryTotal,
                      })
                    : t('characterBrowser.processing')}
              </span>
            </div>
            <div className={styles.importProgressBar}>
              <div
                className={styles.importProgressFill}
                style={{
                  transform: `scaleX(${browser.importProgress.step === 'uploading'
                    ? browser.importProgress.percent / 100
                    : browser.importProgress.step === 'gallery' && browser.importProgress.galleryTotal
                      ? browser.importProgress.galleryCurrent! / browser.importProgress.galleryTotal
                      : 1})`,
                }}
              />
            </div>
          </div>
        </div>
      )}

      {browser.importError && (
        <div className={styles.importError}>
          <span>{browser.importError}</span>
          <button type="button" onClick={browser.clearImportError}>{t('characterBrowser.dismiss')}</button>
        </div>
      )}

      {browser.filterTab === 'groups' ? (
        <GroupChatsPanel viewMode={browser.viewMode} />
      ) : (
        <>
          {!browser.batchMode && browser.favoriteCharacters.length > 0 && (
            <FavoritesSlider
              characters={browser.favoriteCharacters}
              favorites={browser.favorites}
              collapsed={favoritesBarCollapsed}
              onOpen={browser.openChat}
              onToggleFavorite={browser.toggleFavorite}
              onToggleCollapse={handleToggleFavoritesCollapse}
            />
          )}

          {browser.loading ? (
            <CharacterSkeletons viewMode={browser.viewMode} />
          ) : browser.totalFiltered === 0 ? (
            <div className={styles.emptyState}>
              {browser.searchQuery ? t('characterBrowser.noSearchResults') : t('characterBrowser.noCharactersYet')}
            </div>
          ) : (
            <div className={styles.folderGroups}>
              {browser.groupedCharacters.map((group) => {
                const folderKey = group.folder || '__uncategorized'
                const isCollapsed = collapsedFolders.has(folderKey)
                const isRenaming = !!group.folder && renamingFolder === group.folder

                return (
                  <div key={folderKey} className={styles.folderGroup}>
                    <div className={styles.folderHeaderRow}>
                        {isRenaming ? (
                          <div className={styles.folderRenameRow}>
                            <input
                              ref={renameInputRef}
                              className={styles.folderRenameInput}
                              value={renamingValue}
                              onChange={(event) => setRenamingValue(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') void handleRenameFolder()
                                if (event.key === 'Escape' && !renameBusy) {
                                  setRenamingFolder(null)
                                  setRenamingValue('')
                                }
                              }}
                              disabled={renameBusy}
                              placeholder={t('characterBrowser.folderName')}
                            />
                            <button
                              type="button"
                              className={styles.folderActionBtn}
                              onClick={() => void handleRenameFolder()}
                              disabled={
                                renameBusy
                                || !renamingValue.trim()
                                || renamingValue.trim().toLocaleLowerCase() === 'uncategorized'
                                || renamingValue.trim().toLocaleLowerCase() === t('characterBrowser.uncategorized').trim().toLocaleLowerCase()
                              }
                            >
                              <Check size={12} />
                            </button>
                            <button
                              type="button"
                              className={styles.folderActionBtn}
                              onClick={() => {
                                setRenamingFolder(null)
                                setRenamingValue('')
                              }}
                              disabled={renameBusy}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ) : (
                          <>
                            <button type="button" className={styles.folderHeader} onClick={() => toggleFolder(folderKey)}>
                              <ChevronRight size={12} className={`${styles.folderChevron} ${!isCollapsed ? styles.folderChevronOpen : ''}`} />
                              <span className={styles.folderName}>{group.folder || t('characterBrowser.uncategorized')}</span>
                              <span className={styles.folderCount}>{group.characters.length}</span>
                            </button>
                            {group.folder && (
                              <>
                                <button
                                  type="button"
                                  className={styles.folderActionBtn}
                                  onClick={() => {
                                    setRenamingFolder(group.folder)
                                    setRenamingValue(group.folder)
                                  }}
                                  disabled={deletingFolder === group.folder}
                                  title={t('characterBrowser.renameFolder', { name: group.folder })}
                                >
                                  <Pencil size={12} />
                                </button>
                                <button
                                  type="button"
                                  className={`${styles.folderActionBtn} ${styles.folderDeleteBtn}`}
                                  onClick={() => handleDeleteFolder(group.folder)}
                                  disabled={deletingFolder === group.folder}
                                  title={t('characterBrowser.deleteFolder', { name: group.folder })}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </>
                            )}
                          </>
                        )}
                    </div>
                    {!isCollapsed && renderCharacterCards(group.characters)}
                  </div>
                )
              })}
            </div>
          )}

          <div className={styles.paginationBar}>{pagination}</div>
        </>
      )}

      <ImportUrlModal
        isOpen={importUrlOpen}
        onClose={() => setImportUrlOpen(false)}
        onImport={browser.importUrl}
        loading={browser.importLoading}
        error={browser.importError}
      />

      <DragDropOverlay visible={dragging} />

      <ConfirmationModal
        isOpen={confirmDelete}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(false)}
        title={t('characterBrowser.deleteCharactersTitle')}
        message={t('characterBrowser.deleteCharactersMessage', { count: browser.batchSelected.length })}
        variant="danger"
        confirmText={t('characterBrowser.delete')}
      />
      <BulkTagsModal
        isOpen={bulkTagsOpen}
        selectedIds={browser.batchSelected}
        allTags={browser.allTags}
        onClose={() => setBulkTagsOpen(false)}
        onApplied={() => { setBulkTagsOpen(false); browser.refreshBrowser() }}
      />

      <ConfirmationModal
        isOpen={!!browser.pendingLorebookImport}
        onConfirm={async () => {
          const char = browser.pendingLorebookImport
          if (!char) return
          browser.clearPendingLorebookImport()
          try {
            await worldBooksApi.importCharacterBook(char.id)
          } catch { /* silent — user can still import from editor */ }
        }}
        onCancel={() => browser.clearPendingLorebookImport()}
        title={t('characterBrowser.importLorebookTitle')}
        message={
          browser.pendingLorebookImport
            ? t('characterBrowser.importLorebookMessage', {
                name: browser.pendingLorebookImport.name,
                count: getEmbeddedCharacterBookEntryCount(browser.pendingLorebookImport.extensions),
              })
            : ''
        }
        confirmText={t('characterBrowser.import')}
      />

      <BulkImportProgressModal
        isOpen={browser.bulkImportOpen}
        files={browser.bulkImportFiles}
        onComplete={browser.handleBulkImportComplete}
        onClose={browser.closeBulkImport}
      />

      <LorebookImportModal
        isOpen={browser.lorebookModalOpen}
        lorebooks={browser.pendingLorebooks}
        onClose={browser.closeLorebookModal}
      />

      <ExpressionsImportModal
        isOpen={browser.expressionsModalOpen}
        items={browser.pendingExpressions}
        onClose={browser.closeExpressionsModal}
      />

      <AlternateFieldsSummaryModal
        isOpen={browser.altFieldsSummaryOpen}
        items={browser.pendingAltFieldsSummary}
        onClose={browser.closeAltFieldsSummary}
      />

    </div>
  )
}
