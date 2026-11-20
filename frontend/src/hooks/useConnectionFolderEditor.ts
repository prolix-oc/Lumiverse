import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { useConnectionLibrary } from './useConnectionLibrary'
import { validConnectionFolderName, type ConnectionFolder } from '@/lib/connectionLibrary'
import { toast } from '@/lib/toast'

export function useConnectionFolderEditor(
  library: ReturnType<typeof useConnectionLibrary>,
  uncategorized: string,
  onCreated: (id: string) => void,
) {
  const { t } = useTranslation('panels')
  const [editing, setEditing] = useState<{ folderId: string | null; name: string } | null>(null)
  const [deleting, setDeleting] = useState<ConnectionFolder | null>(null)

  const submit = () => {
    if (!editing || !library.ready) return
    if (!validConnectionFolderName(library.library, editing.name, uncategorized, editing.folderId ?? undefined)) {
      toast.error(t('connections.invalidFolderName'))
      return
    }
    if (editing.folderId === null) onCreated(library.createFolder(editing.name.trim()))
    else library.renameFolder(editing.folderId, editing.name.trim())
    setEditing(null)
  }

  return {
    editing, deleting,
    startCreate: () => setEditing({ folderId: null, name: '' }),
    startRename: (folder: ConnectionFolder) => setEditing({ folderId: folder.id, name: folder.name }),
    setName: (name: string) => setEditing(current => current ? { ...current, name } : current),
    cancel: () => setEditing(null),
    submit,
    requestDelete: setDeleting,
    cancelDelete: () => setDeleting(null),
    confirmDelete: (hasEditor: boolean) => {
      if (deleting && !hasEditor) library.deleteFolder(deleting.id)
      setDeleting(null)
    },
  }
}
