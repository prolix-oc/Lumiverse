import { useState, useCallback, useMemo, useEffect, useRef, type ReactNode } from 'react'
import { usePersonaBrowser } from '@/hooks/usePersonaBrowser'
import { useFolders } from '@/hooks/useFolders'
import { useStore } from '@/store'
import { Check, ChevronRight, Pencil, Trash2, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import PersonaToolbar from './persona-browser/PersonaToolbar'
import PersonaCardGrid from './persona-browser/PersonaCardGrid'
import PersonaCardList from './persona-browser/PersonaCardList'
import PersonaEditor from './persona-browser/PersonaEditor'
import CreatePersonaForm from './persona-browser/CreatePersonaForm'
import Pagination from '@/components/shared/Pagination'
import styles from './PersonaManager.module.css'

export default function PersonaManager() {
  const browser = usePersonaBrowser()
  const openModal = useStore((s) => s.openModal)
  const { createFolder, renameFolder: renameStoredFolder, deleteFolder: deleteStoredFolder } = useFolders('personaFolders', browser.allPersonas)
  const [creating, setCreating] = useState(false)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null)
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
      toast.success(`Renamed folder to "${newName}"${result.count > 0 ? ` and updated ${result.count} persona${result.count === 1 ? '' : 's'}` : ''}`)
    } catch (err: any) {
      toast.error(err.body?.error || err.message || 'Failed to rename folder')
    } finally {
      setRenameBusy(false)
    }
  }, [browser, renameStoredFolder, renamingFolder, renamingValue])

  const handleDeleteFolder = useCallback(async (folder: string) => {
    const name = folder.trim()
    if (!name || deletingFolder) return
    openModal('confirm', {
      title: 'Delete Persona Folder',
      message: `Delete folder "${name}"? Personas in this folder will move to Uncategorized.`,
      variant: 'danger',
      confirmText: 'Delete',
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
          toast.success(`Deleted folder "${name}"${result.count > 0 ? ` and moved ${result.count} persona${result.count === 1 ? '' : 's'} to Uncategorized` : ''}`)
        } catch (err: any) {
          toast.error(err.body?.error || err.message || 'Failed to delete folder')
        } finally {
          setDeletingFolder(null)
        }
      },
    })
  }, [browser, deleteStoredFolder, deletingFolder, openModal])

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

  const renderEditor = useCallback(
    (personaId: string): ReactNode => {
      const persona = browser.allPersonas.find((p) => p.id === personaId)
      if (!persona) return null
      return (
        <PersonaEditor
          persona={persona}
          isActive={browser.activePersonaId === persona.id}
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

  if (browser.loading && browser.allPersonas.length === 0) {
    return <div className={styles.loading}>Loading personas...</div>
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
      />

      {creating && (
        <CreatePersonaForm
          onCreate={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}

      {browser.groupedPersonas.length === 0 ? (
        <div className={styles.loading}>No personas found.</div>
      ) : (
        groupedPersonas.map((group) => {
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
                        placeholder="Folder name"
                      />
                      <button
                        type="button"
                        className={styles.folderActionBtn}
                        onClick={() => void handleSubmitRenameFolder()}
                        disabled={renameBusy || !renamingValue.trim()}
                        title="Confirm rename"
                        aria-label="Confirm rename"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        type="button"
                        className={styles.folderActionBtn}
                        onClick={handleCancelRenameFolder}
                        disabled={renameBusy}
                        title="Cancel rename"
                        aria-label="Cancel rename"
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
                        <span className={styles.folderName}>{group.folder || 'Uncategorized'}</span>
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
                            title={`Rename ${group.folder}`}
                            aria-label={`Rename ${group.folder}`}
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
                            title={`Delete ${group.folder}`}
                            aria-label={`Delete ${group.folder}`}
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
                browser.viewMode === 'grid' ? (
                  <PersonaCardGrid
                    personas={group.personas}
                    selectedId={browser.selectedPersonaId}
                    activeId={browser.activePersonaId}
                    onSelect={browser.setSelectedPersonaId}
                    onDoubleClick={handleDoubleClick}
                    renderEditor={renderEditor}
                  />
                ) : (
                  <PersonaCardList
                    personas={group.personas}
                    selectedId={browser.selectedPersonaId}
                    activeId={browser.activePersonaId}
                    onSelect={browser.setSelectedPersonaId}
                    onDoubleClick={handleDoubleClick}
                    renderEditor={renderEditor}
                  />
                )
              )}
            </div>
          )
        })
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
