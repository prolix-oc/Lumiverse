import { useState, useCallback, useRef } from 'react'
import { useCharacterBrowser } from '@/hooks/useCharacterBrowser'
import { worldBooksApi } from '@/api/world-books'
import { useStore } from '@/store'
import CharacterToolbar from './character-browser/CharacterToolbar'
import TagFilter from './character-browser/TagFilter'
import BatchBar from './character-browser/BatchBar'
import FavoritesSlider from './character-browser/FavoritesSlider'
import CharacterGrid from './character-browser/CharacterGrid'
import CharacterList from './character-browser/CharacterList'
import CharacterEditorPage from './character-browser/CharacterEditorPage'
import ImportUrlModal from './character-browser/ImportUrlModal'
import DragDropOverlay from './character-browser/DragDropOverlay'
import GroupChatsPanel from './character-browser/GroupChatsPanel'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import BulkImportProgressModal from '@/components/modals/BulkImportProgressModal'
import LorebookImportModal from '@/components/modals/LorebookImportModal'
import Pagination from '@/components/shared/Pagination'
import styles from './CharacterBrowser.module.css'

export default function CharacterBrowser() {
  const browser = useCharacterBrowser()
  const setEditingCharacterId = useStore((s) => s.setEditingCharacterId)
  const openModal = useStore((s) => s.openModal)
  const handleCreateNew = useCallback(async () => {
    try {
      const character = await browser.createCharacter()
      setEditingCharacterId(character.id)
    } catch (err) {
      console.error('[CharacterBrowser] Failed to create character:', err)
    }
  }, [browser.createCharacter, setEditingCharacterId])

  const [importUrlOpen, setImportUrlOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [dragging, setDragging] = useState(false)
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
        /\.(json|png|charx)$/i.test(f.name)
      )
      if (files.length > 0) {
        browser.importFiles(files)
      }
    },
    [browser.importFiles]
  )

  const handleBatchDelete = useCallback(() => {
    setConfirmDelete(true)
  }, [])

  const handleConfirmDelete = useCallback(() => {
    browser.batchDelete()
    setConfirmDelete(false)
  }, [browser.batchDelete])

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
        onImportUrl={() => setImportUrlOpen(true)}
        onCreateNew={handleCreateNew}
        importLoading={browser.importLoading}
        onGroupChat={() => openModal('groupChatCreator')}
      />

      {browser.allTags.length > 0 && (
        <TagFilter
          allTags={browser.allTags}
          selectedTags={browser.selectedTags}
          onToggleTag={browser.toggleSelectedTag}
          onClearTags={() => browser.setSelectedTags([])}
        />
      )}

      {browser.batchMode && (
        <BatchBar
          selectedCount={browser.batchSelected.length}
          totalCount={browser.characters.length}
          onSelectAll={() => browser.selectAllBatch(browser.characters.map((c) => c.id))}
          onClearSelection={browser.clearBatchSelection}
          onDelete={handleBatchDelete}
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
                  ? `Uploading\u2026 ${browser.importProgress.percent}%`
                  : browser.importProgress.step === 'gallery'
                    ? `Adding to gallery\u2026 ${browser.importProgress.galleryCurrent}/${browser.importProgress.galleryTotal}`
                    : 'Processing\u2026'}
              </span>
            </div>
            <div className={styles.importProgressBar}>
              <div
                className={styles.importProgressFill}
                style={{
                  width: browser.importProgress.step === 'uploading'
                    ? `${browser.importProgress.percent}%`
                    : browser.importProgress.step === 'gallery' && browser.importProgress.galleryTotal
                      ? `${Math.round((browser.importProgress.galleryCurrent! / browser.importProgress.galleryTotal) * 100)}%`
                      : '100%',
                }}
              />
            </div>
          </div>
        </div>
      )}

      {browser.importError && (
        <div className={styles.importError}>
          <span>{browser.importError}</span>
          <button type="button" onClick={browser.clearImportError}>Dismiss</button>
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
              onOpen={browser.openChat}
              onToggleFavorite={browser.toggleFavorite}
            />
          )}

          {browser.loading ? (
            <div className={styles.loadingState}>Loading characters...</div>
          ) : browser.totalFiltered === 0 ? (
            <div className={styles.emptyState}>
              {browser.searchQuery ? 'No characters match your search' : 'No characters yet'}
            </div>
          ) : browser.viewMode === 'grid' || browser.viewMode === 'columns' ? (
            <CharacterGrid
              characters={browser.characters}
              favorites={browser.favorites}
              batchMode={browser.batchMode}
              batchSelected={browser.batchSelected}
              forcedColumns={browser.viewMode === 'columns' ? 2 : undefined}
              onOpen={browser.openChat}
              onEdit={setEditingCharacterId}
              onToggleFavorite={browser.toggleFavorite}
              onToggleBatch={browser.toggleBatchSelect}
            />
          ) : (
            <CharacterList
              characters={browser.characters}
              favorites={browser.favorites}
              batchMode={browser.batchMode}
              batchSelected={browser.batchSelected}
              onOpen={browser.openChat}
              onEdit={setEditingCharacterId}
              onToggleFavorite={browser.toggleFavorite}
              onToggleBatch={browser.toggleBatchSelect}
            />
          )}

          <Pagination
            currentPage={browser.currentPage}
            totalPages={browser.totalPages}
            onPageChange={browser.setCurrentPage}
            perPage={browser.charactersPerPage}
            perPageOptions={[24, 50, 100, 200, 500]}
            onPerPageChange={browser.setCharactersPerPage}
            totalItems={browser.totalFiltered}
          />
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
        title="Delete Characters"
        message={`Are you sure you want to delete ${browser.batchSelected.length} character(s)? This cannot be undone.`}
        variant="danger"
        confirmText="Delete"
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
        title="Import Embedded Lorebook"
        message={
          browser.pendingLorebookImport
            ? `"${browser.pendingLorebookImport.name}" contains an embedded lorebook with ${browser.pendingLorebookImport.extensions?.character_book?.entries?.length} entries. Import it as a World Book?`
            : ''
        }
        confirmText="Import"
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

      <CharacterEditorPage />
    </div>
  )
}
