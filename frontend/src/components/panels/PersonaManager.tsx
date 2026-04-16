import { useState, useCallback, useMemo, type ReactNode } from 'react'
import { usePersonaBrowser } from '@/hooks/usePersonaBrowser'
import { useFolders } from '@/hooks/useFolders'
import { useStore } from '@/store'
import { ChevronRight } from 'lucide-react'
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
  const { createFolder } = useFolders('personaFolders', browser.allPersonas)
  const [creating, setCreating] = useState(false)
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

          return (
            <div key={folderKey} className={styles.folderGroup}>
              {hasFolders && (
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
