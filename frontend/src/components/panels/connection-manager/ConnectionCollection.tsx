import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { FolderPlus, Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DndContext } from '@/lib/dndUiScale'
import SortableFolderSection from '@/components/shared/SortableFolderSection'
import SortableDragOverlay from '@/components/shared/SortableDragOverlay'
import FolderSection, { FolderNameEditor } from '@/components/shared/FolderSection'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { useSortableFolders, sortableFolderId } from '@/hooks/useSortableFolders'
import { ConnectionEditorContext } from '@/hooks/useConnectionEditor'
import { useConnectionEditors } from '@/hooks/useConnectionEditors'
import { useConnectionFolderEditor } from '@/hooks/useConnectionFolderEditor'
import { useConnectionLibrary } from '@/hooks/useConnectionLibrary'
import { useConnectionSearch } from '@/hooks/useConnectionSearch'
import { useConnectionRecents } from '@/hooks/useConnectionRecents'
import { connectionFolderId, type ConnectionLibraryKind } from '@/lib/connectionLibrary'
import type { ConnectionPlacement } from '@/lib/connectionPlacement'
import type { SearchableConnection } from '@/lib/connectionSearch'
import styles from './ConnectionCollection.module.css'
import managerStyles from '../ConnectionManager.module.css'

interface ConnectionCollectionProps<T extends SearchableConnection> {
  kind: ConnectionLibraryKind
  profiles: T[]
  renderProfile: (profile: T, placement: ConnectionPlacement) => ReactNode
  onReorder: (ids: string[]) => void
  emptyMessage: string
  actions?: ReactNode
  editor?: ReactNode
}

/** Shared organization; each manager owns its connection forms and API calls. */
export default function ConnectionCollection<T extends SearchableConnection>({
  kind, profiles, renderProfile, onReorder, emptyMessage, actions, editor,
}: ConnectionCollectionProps<T>) {
  const { t } = useTranslation('panels')
  const { t: ts } = useTranslation('shared')
  const library = useConnectionLibrary(kind)
  const recentIds = useConnectionRecents(kind)
  const uncategorized = ts('searchableSelect.uncategorized')
  const { query, visibleProfiles } = useConnectionSearch(profiles, id => library.folderName(id) || uncategorized)
  const searching = !!query.trim()
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  // Search opens matches temporarily without changing manual expansion state.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const defaultCollapsed = library.folders.length > 1
  const expandFolder = useCallback((id: string) => {
    setCollapsed(current => current[id] === false ? current : { ...current, [id]: false })
  }, [])
  const expandProfileFolder = useCallback((id: string) => {
    expandFolder(connectionFolderId(library.library, id))
  }, [expandFolder, library.library])
  const editors = useConnectionEditors(profiles, recentIds, expandProfileFolder)
  const folderEditor = useConnectionFolderEditor(library, uncategorized, expandFolder)

  const visibleById = new Map(visibleProfiles.map(profile => [profile.id, profile]))
  const allById = new Map(profiles.map(profile => [profile.id, profile]))
  const recentProfiles = editors.recentIds.map(id => allById.get(id)).filter((profile): profile is T => !!profile)
  const recentCount = recentProfiles.filter(profile => visibleById.has(profile.id)).length
  const sort = useSortableFolders({
    groups: library.folders.map(folder => ({
      id: folder.id,
      items: profiles.filter(profile => library.folderId(profile.id) === folder.id).map(profile => profile.id),
    })),
    listRef,
    disabled: !library.ready,
    filtered: searching,
    onExpand: expandFolder,
    onMove: (id, folder, ordered) => {
      if (library.folderId(id) !== folder) {
        library.assign(id, folder)
        editors.focusEntry(id, 'list')
      }
      onReorder(ordered)
    },
    onReorder: library.reorder,
  })
  const activeProfile = sort.activeItem ? allById.get(sort.activeItem) : undefined
  const draggingConnection = sort.activeItem !== null
  const groups = sort.groups.flatMap(group => {
    const folder = library.folders.find(folder => folder.id === group.id)
    return folder ? [{
      folder,
      profiles: group.items.map(id => allById.get(id)).filter((profile): profile is T => !!profile),
      collapsed: !searching && (collapsed[group.id] ?? defaultCollapsed),
    }] : []
  })
  const folderHasEditor = (folderId: string) => profiles.some(profile =>
    library.folderId(profile.id) === folderId && editors.hasEditor(profile.id))

  const renderFolderEditor = (submitLabel?: string) => folderEditor.editing && (
    <FolderNameEditor value={folderEditor.editing.name} onChange={folderEditor.setName}
      submitLabel={submitLabel} onCancel={folderEditor.cancel} onSubmit={folderEditor.submit} />
  )

  return (
    <ConnectionEditorContext.Provider value={editors.context}>
      <div className={styles.collection} ref={listRef} data-connection-drag={draggingConnection || undefined}>
        <div className={styles.toolbar}>
          {actions}
          <button type="button" className={managerStyles.createBtn}
            disabled={!library.ready || folderEditor.editing?.folderId === null}
            onClick={folderEditor.startCreate}>
            <FolderPlus size={14} /><span>{t('connections.newFolder')}</span>
          </button>
        </div>
        {folderEditor.editing?.folderId === null && renderFolderEditor(t('connections.newFolder'))}
        {editor}
        {visibleProfiles.length === 0 && <div className={styles.empty} role="status">
          {searching ? t('connections.noMatches') : emptyMessage}
        </div>}
        {recentProfiles.length > 0 && <div hidden={recentCount === 0}>
          <FolderSection recent label={ts('searchableSelect.recentlyUsed')} count={recentCount}>
            <div className={styles.items} data-connection-placement="recent">
              {recentProfiles.map(profile => (
                <div key={profile.id} hidden={!visibleById.has(profile.id)} tabIndex={-1}
                  ref={node => editors.registerEntry(profile.id, 'recent', node)}>
                  {renderProfile(profile, 'recent')}
                </div>
              ))}
            </div>
          </FolderSection>
        </div>}
        <DndContext {...sort.contextProps}>
          <SortableContext items={groups.map(group => sortableFolderId(group.folder.id))}
            strategy={verticalListSortingStrategy} disabled={!library.ready}>
            <div className={styles.items}>
              {/* Keep collapsed and filtered forms mounted so their drafts survive. */}
              {groups.map(({ folder, profiles: members, collapsed: isCollapsed }) => {
                const count = members.filter(profile => visibleById.has(profile.id)).length
                const hasEditor = folderHasEditor(folder.id)
                return <SortableFolderSection key={sortableFolderId(folder.id)} id={folder.id}
                  label={folder.name || uncategorized} count={count} disabled={!library.ready} reorderDisabled={searching}
                  receiving={sort.receivingFolder === folder.id}
                  hidden={searching && !draggingConnection && count === 0} collapsed={isCollapsed}
                  controls={members.map(profile => `${listId}-${profile.id}`).join(' ') || undefined}
                  onToggle={() => setCollapsed(value => ({ ...value, [folder.id]: !(value[folder.id] ?? defaultCollapsed) }))}
                  header={folderEditor.editing?.folderId === folder.id ? renderFolderEditor() : undefined}
                  actions={folder.id && <>
                    <button type="button" className={styles.iconButton} onClick={() => folderEditor.startRename(folder)}
                      aria-label={ts('folderDropdown.renameFolder', { name: folder.name })}><Pencil size={12} /></button>
                    <button type="button" className={styles.iconButton} onClick={() => folderEditor.requestDelete(folder)} disabled={hasEditor}
                      title={hasEditor ? t('connections.finishEditBeforeDelete') : undefined}
                      aria-label={ts('folderDropdown.deleteFolder', { name: folder.name })}><Trash2 size={12} /></button>
                  </>}>
                  <SortableContext items={members.filter(profile => visibleById.has(profile.id)).map(profile => profile.id)}
                    strategy={verticalListSortingStrategy} disabled={!library.ready}>
                    <div className={styles.items}>
                      {members.map(profile => (
                        <div key={profile.id} id={`${listId}-${profile.id}`} className={styles.entry}
                          tabIndex={-1} hidden={!visibleById.has(profile.id)}
                          ref={node => editors.registerEntry(profile.id, 'list', node)}>
                          {renderProfile(profile, 'list')}
                        </div>
                      ))}
                    </div>
                  </SortableContext>
                </SortableFolderSection>
              })}
            </div>
          </SortableContext>
          <SortableDragOverlay className={styles.preview}>
            {activeProfile && <div data-connection-drag-preview>{renderProfile(activeProfile, 'preview')}</div>}
          </SortableDragOverlay>
        </DndContext>
        {folderEditor.deleting && <ConfirmationModal isOpen
          title={ts('folderDropdown.deleteFolder', { name: folderEditor.deleting.name })}
          message={t('connections.deleteFolderMessage', { name: folderEditor.deleting.name })}
          onCancel={folderEditor.cancelDelete}
          onConfirm={() => folderEditor.confirmDelete(folderHasEditor(folderEditor.deleting!.id))} />}
      </div>
    </ConnectionEditorContext.Provider>
  )
}
