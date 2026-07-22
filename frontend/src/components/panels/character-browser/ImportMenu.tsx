import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, FileUp, Link, UserPlus, Tags, FolderPlus, Check, X } from 'lucide-react'
import styles from './ImportMenu.module.css'

interface ImportMenuProps {
  onImportFile: (files: File[]) => void
  onImportTagLibrary: (file: File) => void
  onImportUrl: () => void
  onCreateNew: () => void
  onCreateFolder: (name: string) => void
  importLoading: boolean
  tagLibraryImporting?: boolean
}

const ACCEPTED_TYPES = '.json,.png,.charx,.jpg,.jpeg'

export default function ImportMenu({
  onImportFile,
  onImportTagLibrary,
  onImportUrl,
  onCreateNew,
  onCreateFolder,
  importLoading,
  tagLibraryImporting = false,
}: ImportMenuProps) {
  const { t } = useTranslation('panels')
  const [open, setOpen] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderName, setFolderName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const tagLibraryInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  // Close on outside click — pointerdown + guard required on Android
  useEffect(() => {
    if (!open) return
    const openedAt = Date.now()
    const handler = (e: PointerEvent) => {
      if (e.timeStamp < openedAt + 100) return
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setCreatingFolder(false)
        setFolderName('')
      }
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [open])

  useEffect(() => {
    if (creatingFolder) folderInputRef.current?.focus()
  }, [creatingFolder])

  const handleCreateFolder = () => {
    const name = folderName.trim()
    if (!name) return
    onCreateFolder(name)
    setFolderName('')
    setCreatingFolder(false)
    setOpen(false)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) {
      // Ask the mobile layout recovery shim to re-sync the viewport after the
      // system file picker closes, before the modal opens.
      window.dispatchEvent(new CustomEvent('lumiverse:recover-mobile-layout'))
      onImportFile(files)
    }
    setOpen(false)
    // Reset input so same file can be re-selected
    e.target.value = ''
  }

  const handleTagLibraryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    if (file) {
      onImportTagLibrary(file)
    }
    setOpen(false)
    e.target.value = ''
  }

  return (
    <div className={styles.container} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(!open)}
        title={t('characterBrowser.addCharacter')}
        disabled={importLoading || tagLibraryImporting}
      >
        <Plus size={14} />
      </button>
      {open && (
        <div className={styles.dropdown}>
          {creatingFolder ? (
            <div className={styles.folderCreateRow}>
              <input
                ref={folderInputRef}
                className={styles.folderInput}
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleCreateFolder()
                  if (event.key === 'Escape') {
                    setCreatingFolder(false)
                    setFolderName('')
                  }
                }}
                placeholder={t('characterBrowser.folderName')}
                maxLength={64}
              />
              <button type="button" className={styles.folderAction} onClick={handleCreateFolder} disabled={!folderName.trim()}>
                <Check size={12} />
              </button>
              <button
                type="button"
                className={styles.folderAction}
                onClick={() => {
                  setCreatingFolder(false)
                  setFolderName('')
                }}
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <>
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              setOpen(false)
              onCreateNew()
            }}
          >
            <UserPlus size={14} />
            <span>{t('characterBrowser.createNew')}</span>
          </button>
          <button type="button" className={styles.item} onClick={() => setCreatingFolder(true)}>
            <FolderPlus size={14} />
            <span>{t('characterBrowser.newFolder')}</span>
          </button>
          <button
            type="button"
            className={styles.item}
            onClick={() => fileInputRef.current?.click()}
            disabled={tagLibraryImporting}
          >
            <FileUp size={14} />
            <span>{t('characterBrowser.importFile')}</span>
          </button>
          <button
            type="button"
            className={styles.item}
            onClick={() => tagLibraryInputRef.current?.click()}
            disabled={tagLibraryImporting}
          >
            <Tags size={14} />
            <span>{tagLibraryImporting ? t('characterBrowser.importingTags') : t('characterBrowser.importTagLibrary')}</span>
          </button>
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              setOpen(false)
              onImportUrl()
            }}
          >
            <Link size={14} />
            <span>{t('characterBrowser.importUrl')}</span>
          </button>
            </>
          )}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
      <input
        ref={tagLibraryInputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleTagLibraryChange}
        style={{ display: 'none' }}
      />
    </div>
  )
}
