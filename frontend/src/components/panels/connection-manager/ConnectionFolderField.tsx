import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionLibrary } from '@/hooks/useConnectionLibrary'
import { validConnectionFolderName, type ConnectionLibraryKind } from '@/lib/connectionLibrary'
import { toast } from '@/lib/toast'
import { FormField } from '@/components/shared/FormComponents'
import FolderDropdown from '@/components/shared/FolderDropdown'

export function useConnectionFolderDraft(kind: ConnectionLibraryKind, profileId?: string) {
  const library = useConnectionLibrary(kind)
  const [draft, setDraft] = useState<string | null>(null)
  // Until the user edits it, follow settings hydration and changes from other tabs.
  const id = draft ?? library.folderId(profileId ?? '')
  return { value: library.folders.some(folder => folder.id === id) ? id : '', onChange: setDraft }
}

export default function ConnectionFolderField({ kind, value, onChange }: {
  kind: ConnectionLibraryKind
  value: string
  onChange: (id: string) => void
}) {
  const { t } = useTranslation('panels')
  const { t: ts } = useTranslation('shared')
  const library = useConnectionLibrary(kind)
  const uncategorized = ts('searchableSelect.uncategorized')
  return <FormField label={t('connections.folder')}>
    <FolderDropdown disabled={!library.ready}
      folders={library.folders.filter(folder => folder.id).map(folder => folder.name)}
      selectedFolder={library.folders.find(folder => folder.id === value)?.name ?? ''}
      placeholder={uncategorized} noneLabel={uncategorized}
      onSelect={name => onChange(library.findFolder(name))}
      onCreateFolder={name => {
        if (!validConnectionFolderName(library.library, name, uncategorized)) {
          toast.error(t('connections.invalidFolderName'))
          return false
        }
        library.createFolder(name.trim())
        return true
      }} />
  </FormField>
}
