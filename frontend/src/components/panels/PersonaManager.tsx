import { useState, useCallback, useMemo, useEffect, useRef, type ReactNode } from 'react'
import { usePersonaBrowser } from '@/hooks/usePersonaBrowser'
import { useFolders } from '@/hooks/useFolders'
import { useStore } from '@/store'
import { Check, ChevronRight, History, Pencil, Trash2, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { triggerBlobDownload } from '@/lib/downloads'
import { worldBooksApi } from '@/api/world-books'
import PersonaToolbar from './persona-browser/PersonaToolbar'
import PersonaCardGrid from './persona-browser/PersonaCardGrid'
import PersonaCardList from './persona-browser/PersonaCardList'
import PersonaBulkBar, { type PersonaBulkAction } from './persona-browser/PersonaBulkBar'
import PersonaEditor from './persona-browser/PersonaEditor'
import CreatePersonaForm from './persona-browser/CreatePersonaForm'
import Pagination from '@/components/shared/Pagination'
import { useTranslation } from 'react-i18next'
import type { Persona, WorldBook } from '@/types/api'
import styles from './PersonaManager.module.css'

export default function PersonaManager() {
  const { t } = useTranslation('panels')
  const browser = usePersonaBrowser()
  const openModal = useStore((s) => s.openModal)
  const { createFolder, renameFolder: renameStoredFolder, deleteFolder: deleteStoredFolder } = useFolders('personaFolders', browser.allPersonas)
  const [creating, setCreating] = useState(false)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [batchSelectedIds, setBatchSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([])
  const renameInputRef = useRef<HTMLInputElement>(null)
  // Collapsed folders — start with all named folders collapsed, uncategorized open
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [initializedFolders, setInitializedFolders] = useState(false)

  // Auto-collapse named folders once we know them
  const groupedPersonas = browser.groupedPersonas
  useMemo(() => {
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
    if (!renamingFolder || !renameInputRef.current) return
    renameInputRef.current.focus()
    renameInputRef.current.select()
  }, [renamingFolder])

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

  const handleBulkAction = useCallback(async (action: PersonaBulkAction, value?: string) => {
    const ids = [...batchSelectedIds]
    if (ids.length === 0) return false

    if (action === 'export') {
      const selected = browser.allPersonas.filter((persona) => batchSelectedIds.has(persona.id))
      const payload = {
        type: 'lumiverse_personas',
        version: 1,
        exported_at: new Date().toISOString(),
        personas: selected,
      }
      triggerBlobDownload(
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

  const renderPersonaCards = useCallback((personas: Persona[]) => {
    const commonProps = {
      personas,
      selectedId: browser.selectedPersonaId,
      activeId: browser.activePersonaId,
      onSelect: browser.setSelectedPersonaId,
      onDoubleClick: handleDoubleClick,
      renderEditor,
      batchMode,
      batchSelectedIds,
      onToggleBatch: toggleBatchPersona,
    }
    return browser.viewMode === 'grid'
      ? <PersonaCardGrid {...commonProps} />
      : <PersonaCardList {...commonProps} />
  }, [batchMode, batchSelectedIds, browser, handleDoubleClick, renderEditor, toggleBatchPersona])

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
          browser.setSelectedPersonaId(null)
        }}
      />

      {batchMode && (
        <PersonaBulkBar
          selectedCount={batchSelectedIds.size}
          totalCount={browser.allPersonas.length}
          folders={browser.allFolders}
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

      {browser.totalFiltered === 0 ? (
        <div className={styles.loading}>{t('personaManager.noPersonasFound')}</div>
      ) : (
        <>
          {browser.recentPersonas.length > 0 && (
            <div className={styles.folderGroup}>
              <div className={styles.recentHeader}>
                <History size={12} />
                <span className={styles.folderName}>{t('personaManager.recentlyUsed')}</span>
                <span className={styles.folderCount}>{browser.recentPersonas.length}</span>
              </div>
              {renderPersonaCards(browser.recentPersonas)}
            </div>
          )}
          {groupedPersonas.map((group) => {
          const folderKey = group.folder || '__uncategorized'
          const hasFolders = browser.allFolders.length > 0 || group.folder
          const isCollapsed = collapsedFolders.has(folderKey)
          const isRenaming = group.folder && renamingFolder === group.folder

          return (
            <div key={folderKey} className={styles.folderGroup}>
              {hasFolders && (
                <div className={styles.folderHeaderRow}>
                  {isRenaming ? (
                    <div className={styles.folderRenameRow} onClick={(e) => e.stopPropagation()}>
                      <input
                        ref={renameInputRef}
                        type="text"
                        className={styles.folderRenameInput}
                        value={renamingValue}
                        onChange={(e) => setRenamingValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleSubmitRenameFolder()
                          if (e.key === 'Escape') handleCancelRenameFolder()
                        }}
                        disabled={renameBusy}
                        placeholder={t('personaManager.folderName')}
                      />
                      <button
                        type="button"
                        className={styles.folderActionBtn}
                        onClick={() => void handleSubmitRenameFolder()}
                        disabled={renameBusy || !renamingValue.trim()}
                        title={t('personaManager.confirmRename')}
                        aria-label={t('personaManager.confirmRename')}
                      >
                        <Check size={12} />
                      </button>
                      <button
                        type="button"
                        className={styles.folderActionBtn}
                        onClick={handleCancelRenameFolder}
                        disabled={renameBusy}
                        title={t('personaManager.cancelRename')}
                        aria-label={t('personaManager.cancelRename')}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={styles.folderHeader}
                        onClick={() => toggleFolder(folderKey)}
                      >
                        <ChevronRight
                          size={12}
                          className={`${styles.folderChevron} ${!isCollapsed ? styles.folderChevronOpen : ''}`}
                        />
                        <span className={styles.folderName}>{group.folder || t('personaManager.uncategorized')}</span>
                        <span className={styles.folderCount}>{group.personas.length}</span>
                      </button>
                      {group.folder && (
                        <>
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
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
              {!isCollapsed && (
                renderPersonaCards(group.personas)
              )}
            </div>
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
