import { useState, useCallback, useMemo, useEffect, type ReactNode } from 'react'
import { usePersonaBrowser } from '@/hooks/usePersonaBrowser'
import { useFolders } from '@/hooks/useFolders'
import { useStore } from '@/store'
import { Pencil, Trash2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { triggerBlobDownload } from '@/lib/downloads'
import { includeEmptyPersonaFolders } from '@/lib/personaBrowser'
import { worldBooksApi } from '@/api/world-books'
import { personasApi } from '@/api/personas'
import {
  parsePersonaExportPayload,
  PersonaImportFormatError,
  PERSONA_EXPORT_TYPE,
  PERSONA_EXPORT_VERSION,
} from '@/lib/personaImport'
import PersonaToolbar from './persona-browser/PersonaToolbar'
import PersonaCardGrid from './persona-browser/PersonaCardGrid'
import PersonaCardList from './persona-browser/PersonaCardList'
import PersonaBulkBar, { type PersonaBulkAction } from './persona-browser/PersonaBulkBar'
import PersonaEditor from './persona-browser/PersonaEditor'
import CreatePersonaForm from './persona-browser/CreatePersonaForm'
import Pagination from '@/components/shared/Pagination'
import FolderSection, { FolderNameEditor } from '@/components/shared/FolderSection'
import { useTranslation } from 'react-i18next'
import type { Persona, WorldBook } from '@/types/api'
import styles from './PersonaManager.module.css'

export default function PersonaManager() {
  const { t } = useTranslation('panels')
  const browser = usePersonaBrowser()
  const openModal = useStore((s) => s.openModal)
  const {
    folders,
    createFolder,
    renameFolder: renameStoredFolder,
    deleteFolder: deleteStoredFolder,
  } = useFolders('personaFolders', browser.allPersonas)
  const [creating, setCreating] = useState(false)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [batchSelectedIds, setBatchSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([])
  const [selectedPlacement, setSelectedPlacement] = useState<'recent' | 'folders'>('folders')
  // Collapsed folders — start with all named folders collapsed, uncategorized open
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [initializedFolders, setInitializedFolders] = useState(false)

  // Auto-collapse named folders once we know them
  const showEmptyFolders = browser.filterType === 'all' && !browser.searchQuery.trim()
  const groupedPersonas = useMemo(
    () => includeEmptyPersonaFolders(
      browser.groupedPersonas,
      showEmptyFolders ? folders : [],
      browser.allPersonas,
    ),
    [browser.allPersonas, browser.groupedPersonas, folders, showEmptyFolders],
  )
  useEffect(() => {
    if (initializedFolders || groupedPersonas.length === 0) return
    const named = groupedPersonas
      .filter((g) => g.folder)
      .map((g) => g.folder!)
    if (named.length > 0) {
      setCollapsedFolders(new Set(named))
      setInitializedFolders(true)
    }
  }, [groupedPersonas, initializedFolders])

  const toggleFolder = useCallback((folder: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }, [])

  useEffect(() => {
    if (!batchMode || worldBooks.length > 0) return
    worldBooksApi.listAll()
      .then(setWorldBooks)
      .catch(() => {})
  }, [batchMode, worldBooks.length])

  useEffect(() => {
    const existingIds = new Set(browser.allPersonas.map((persona) => persona.id))
    setBatchSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => existingIds.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [browser.allPersonas])

  const handleStartRenameFolder = useCallback((folder: string) => {
    setRenamingFolder(folder)
    setRenamingValue(folder)
  }, [])

  const handleCancelRenameFolder = useCallback(() => {
    if (renameBusy) return
    setRenamingFolder(null)
    setRenamingValue('')
  }, [renameBusy])

  const handleSubmitRenameFolder = useCallback(async () => {
    if (!renamingFolder) return

    const oldName = renamingFolder.trim()
    const newName = renamingValue.trim()
    if (!newName) return
    if (oldName === newName) {
      setRenamingFolder(null)
      setRenamingValue('')
      return
    }

    setRenameBusy(true)
    try {
      const result = await browser.renameFolder(oldName, newName)
      renameStoredFolder(oldName, newName)
      setCollapsedFolders((prev) => {
        const next = new Set(prev)
        const wasCollapsed = next.delete(oldName)
        if (wasCollapsed) next.add(newName)
        return next
      })
      setRenamingFolder(null)
      setRenamingValue('')
      toast.success(t('personaManager.renamedFolderSuccess', { name: newName, count: result.count }))
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('personaManager.renameFolderFailed'))
    } finally {
      setRenameBusy(false)
    }
  }, [browser, renameStoredFolder, renamingFolder, renamingValue, t])

  const handleDeleteFolder = useCallback(async (folder: string) => {
    const name = folder.trim()
    if (!name || deletingFolder) return
    openModal('confirm', {
      title: t('personaManager.deleteFolderTitle'),
      message: t('personaManager.deleteFolderMessage', { name }),
      variant: 'danger',
      confirmText: t('personaManager.delete'),
      onConfirm: async () => {
        setDeletingFolder(name)
        try {
          const result = await browser.deleteFolder(name)
          deleteStoredFolder(name)
          setCollapsedFolders((prev) => {
            const next = new Set(prev)
            next.delete(name)
            return next
          })
          toast.success(t('personaManager.deletedFolderSuccess', { name, count: result.count }))
        } catch (err: any) {
          toast.error(err.body?.error || err.message || t('personaManager.deleteFolderFailed'))
        } finally {
          setDeletingFolder(null)
        }
      },
    })
  }, [browser, deleteStoredFolder, deletingFolder, openModal, t])

  const handleCreate = useCallback(
    async (name: string, avatarFile?: File, originalFile?: File) => {
      const persona = await browser.createPersona({ name })
      if (avatarFile) {
        await browser.uploadAvatar(persona.id, avatarFile, originalFile)
      }
      setCreating(false)
      setSelectedPlacement('folders')
      browser.setSelectedPersonaId(persona.id)
    },
    [browser]
  )

  const handleDoubleClick = useCallback(
    (id: string) => {
      browser.switchToPersona(id)
    },
    [browser]
  )

  const toggleBatchPersona = useCallback((id: string) => {
    setBatchSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const closeBatchMode = useCallback(() => {
    if (bulkBusy) return
    setBatchMode(false)
    setBatchSelectedIds(new Set())
  }, [bulkBusy])

  const handleBulkAction = useCallback(async (action: PersonaBulkAction, value?: string, file?: File) => {
    if (action === 'import') {
      if (!file) return false

      setBulkBusy(true)
      try {
        let payload: unknown
        try {
          payload = JSON.parse(await file.text())
        } catch {
          toast.error(t('personaManager.bulk.invalidJson'))
          return false
        }

        let personas: unknown[]
        try {
          personas = parsePersonaExportPayload(payload)
        } catch (error) {
          const key = error instanceof PersonaImportFormatError
            ? error.code === 'unsupported_version'
              ? 'unsupportedVersion'
              : error.code === 'empty_export'
                ? 'emptyExport'
                : 'invalidExport'
            : 'invalidExport'
          toast.error(t(`personaManager.bulk.${key}`))
          return false
        }

        const result = await personasApi.bulkImport(personas)
        await browser.refresh()

        if (result.errors.length > 0) {
          console.warn('[PersonaManager] Persona import failures:', result.errors)
        }
        if (result.count === 0) {
          toast.error(t('personaManager.bulk.importNone', {
            failed: result.failed,
            reason: result.errors[0]?.error || t('personaManager.bulk.importFailed'),
          }))
          return false
        }

        const hasReferenceWarnings = result.warnings.detached_world_books > 0
          || result.warnings.skipped_asset_references > 0
        if (hasReferenceWarnings) {
          toast.warning(t('personaManager.bulk.importedWithWarnings', {
            count: result.count,
            failed: result.failed,
            detached: result.warnings.detached_world_books,
            assets: result.warnings.skipped_asset_references,
          }))
        } else if (result.failed > 0) {
          toast.warning(t('personaManager.bulk.importedPartial', {
            count: result.count,
            failed: result.failed,
          }))
        } else {
          toast.success(t('personaManager.bulk.imported', { count: result.count }))
        }
        return true
      } catch (err: any) {
        toast.error(err.body?.error || err.message || t('personaManager.bulk.importFailed'))
        return false
      } finally {
        setBulkBusy(false)
      }
    }

    const ids = [...batchSelectedIds]
    if (ids.length === 0) return false

    if (action === 'export') {
      const selected = browser.allPersonas.filter((persona) => batchSelectedIds.has(persona.id))
      const payload = {
        type: PERSONA_EXPORT_TYPE,
        version: PERSONA_EXPORT_VERSION,
        exported_at: new Date().toISOString(),
        personas: selected,
      }
      await triggerBlobDownload(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
        `lumiverse-personas-${new Date().toISOString().slice(0, 10)}.json`,
      )
      toast.success(t('personaManager.bulk.exported', { count: selected.length }))
      return true
    }

    if (action === 'delete') {
      openModal('confirm', {
        title: t('personaManager.bulk.deleteTitle'),
        message: t('personaManager.bulk.deleteMessage', { count: ids.length }),
        variant: 'danger',
        confirmText: t('personaManager.bulk.delete'),
        onConfirm: async () => {
          setBulkBusy(true)
          try {
            const result = await browser.bulkDeletePersonas(ids)
            toast.success(t('personaManager.bulk.deleted', { count: result.count }))
            setBatchSelectedIds(new Set())
            setBatchMode(false)
          } catch (err: any) {
            toast.error(err.body?.error || err.message || t('personaManager.bulk.failed'))
          } finally {
            setBulkBusy(false)
          }
        },
      })
      return true
    }

    setBulkBusy(true)
    try {
      const input = action === 'move'
        ? { folder: value?.trim() || '' }
        : action === 'attachLorebook'
          ? { attached_world_book_id: value! }
          : action === 'removeLorebook'
            ? { attached_world_book_id: null }
            : { toggle_narrator: true }
      const result = await browser.bulkUpdatePersonas(ids, input)
      toast.success(t('personaManager.bulk.updated', { count: result.count }))
      setBatchSelectedIds(new Set())
      return true
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('personaManager.bulk.failed'))
      return false
    } finally {
      setBulkBusy(false)
    }
  }, [batchSelectedIds, browser, openModal, t])

  const renderEditor = useCallback(
    (personaId: string): ReactNode => {
      const persona = browser.allPersonas.find((p) => p.id === personaId)
      if (!persona) return null
      return (
        <PersonaEditor
          persona={persona}
          isActive={browser.activePersonaId === persona.id}
          isSwitchActive={browser.isChatScoped ? browser.persistedChatPersonaId === persona.id : browser.activePersonaId === persona.id}
          onUpdate={browser.updatePersona}
          onDelete={async (id) => {
            await browser.deletePersona(id)
          }}
          onDuplicate={browser.duplicatePersona}
          onUploadAvatar={browser.uploadAvatar}
          onToggleDefault={browser.toggleDefault}
          onSetLorebook={browser.setLorebook}
          onSwitchTo={browser.switchToPersona}
        />
      )
    },
    [browser]
  )

  const renderPersonaCards = useCallback((personas: Persona[], placement: 'recent' | 'folders' = 'folders') => {
    const ownsSelection = selectedPlacement === placement
    const commonProps = {
      personas,
      selectedId: ownsSelection ? browser.selectedPersonaId : null,
      activeId: browser.activePersonaId,
      onSelect: (id: string | null) => {
        setSelectedPlacement(placement)
        browser.setSelectedPersonaId(id)
      },
      onDoubleClick: handleDoubleClick,
      renderEditor: ownsSelection ? renderEditor : undefined,
      batchMode,
      batchSelectedIds,
      onToggleBatch: toggleBatchPersona,
    }
    return browser.viewMode === 'grid'
      ? <PersonaCardGrid {...commonProps} />
      : <PersonaCardList {...commonProps} />
  }, [batchMode, batchSelectedIds, browser, handleDoubleClick, renderEditor, selectedPlacement, toggleBatchPersona])

  if (browser.loading && browser.allPersonas.length === 0) {
    return <div className={styles.loading}>{t('personaManager.loading')}</div>
  }

  return (
    <div className={styles.manager}>
      <PersonaToolbar
        searchQuery={browser.searchQuery}
        onSearchChange={browser.setSearchQuery}
        filterType={browser.filterType}
        onFilterTypeChange={browser.setFilterType}
        sortField={browser.sortField}
        onSortFieldChange={browser.setSortField}
        sortDirection={browser.sortDirection}
        onToggleSortDirection={browser.toggleSortDirection}
        viewMode={browser.viewMode}
        onViewModeChange={browser.setViewMode}
        onCreateClick={() => setCreating(true)}
        onCreateFolder={createFolder}
        onRefresh={browser.refresh}
        onGlobalLibraryClick={() => openModal('globalAddonsLibrary')}
        filteredCount={browser.totalFiltered}
        totalCount={browser.allPersonas.length}
        batchMode={batchMode}
        onBatchModeChange={(enabled) => {
          setBatchMode(enabled)
          if (!enabled) setBatchSelectedIds(new Set())
          setSelectedPlacement('folders')
          browser.setSelectedPersonaId(null)
        }}
      />

      {batchMode && (
        <PersonaBulkBar
          selectedCount={batchSelectedIds.size}
          totalCount={browser.allPersonas.length}
          folders={folders}
          worldBooks={worldBooks}
          busy={bulkBusy}
          onSelectAll={() => setBatchSelectedIds(new Set(browser.allPersonas.map((persona) => persona.id)))}
          onClearSelection={() => setBatchSelectedIds(new Set())}
          onCancel={closeBatchMode}
          onApply={handleBulkAction}
        />
      )}

      {creating && (
        <CreatePersonaForm
          onCreate={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}

      {browser.totalFiltered === 0 && groupedPersonas.length === 0 ? (
        <div className={styles.loading}>{t('personaManager.noPersonasFound')}</div>
      ) : (
        <>
          {browser.recentPersonas.length > 0 && (
            <FolderSection recent label={t('personaManager.recentlyUsed')} count={browser.recentPersonas.length}>
              {renderPersonaCards(browser.recentPersonas, 'recent')}
            </FolderSection>
          )}
          {groupedPersonas.map((group) => {
          const folderKey = group.folder || '__uncategorized'
          const hasFolders = folders.length > 0 || group.folder
          const isCollapsed = collapsedFolders.has(folderKey)
          const isRenaming = group.folder && renamingFolder === group.folder

          return (
            <FolderSection
              key={folderKey}
              label={group.folder || t('personaManager.uncategorized')}
              count={group.personas.length}
              hideHeader={!hasFolders}
              collapsed={isCollapsed}
              onToggle={() => toggleFolder(folderKey)}
              header={isRenaming ? (
                <FolderNameEditor value={renamingValue} onChange={setRenamingValue}
                  onSubmit={() => void handleSubmitRenameFolder()} onCancel={handleCancelRenameFolder}
                  disabled={renameBusy} placeholder={t('personaManager.folderName')} />
              ) : undefined}
              actions={group.folder ? <>
                <button
                  type="button"
                  className={styles.folderActionBtn}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleStartRenameFolder(group.folder)
                  }}
                  disabled={deletingFolder === group.folder}
                  title={t('personaManager.renameFolder', { name: group.folder })}
                  aria-label={t('personaManager.renameFolder', { name: group.folder })}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className={`${styles.folderActionBtn} ${styles.folderDeleteBtn}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleDeleteFolder(group.folder)
                  }}
                  disabled={deletingFolder === group.folder}
                  title={t('personaManager.deleteFolder', { name: group.folder })}
                  aria-label={t('personaManager.deleteFolder', { name: group.folder })}
                >
                  <Trash2 size={12} />
                </button>
              </> : undefined}
            >
              {renderPersonaCards(group.personas)}
            </FolderSection>
          )
          })}
        </>
      )}

      <Pagination
        currentPage={browser.currentPage}
        totalPages={browser.totalPages}
        onPageChange={browser.setCurrentPage}
        perPage={browser.personasPerPage}
        perPageOptions={[12, 24, 50, 100]}
        onPerPageChange={browser.setPersonasPerPage}
        totalItems={browser.totalFiltered}
      />

    </div>
  )
}
