import { useState, useRef, useEffect } from 'react'
import { Plus, FileUp, Link, UserPlus, Tags } from 'lucide-react'
import styles from './ImportMenu.module.css'

interface ImportMenuProps {
  onImportFile: (files: File[]) => void
  onImportTagLibrary: (file: File) => void
  onImportUrl: () => void
  onCreateNew: () => void
  importLoading: boolean
  tagLibraryImporting?: boolean
}

const ACCEPTED_TYPES = '.json,.png,.charx,.jpg,.jpeg'

export default function ImportMenu({
  onImportFile,
  onImportTagLibrary,
  onImportUrl,
  onCreateNew,
  importLoading,
  tagLibraryImporting = false,
}: ImportMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const tagLibraryInputRef = useRef<HTMLInputElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) {
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
        title="Add character"
        disabled={importLoading || tagLibraryImporting}
      >
        <Plus size={14} />
      </button>
      {open && (
        <div className={styles.dropdown}>
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              setOpen(false)
              onCreateNew()
            }}
          >
            <UserPlus size={14} />
            <span>Create New</span>
          </button>
          <button
            type="button"
            className={styles.item}
            onClick={() => fileInputRef.current?.click()}
            disabled={tagLibraryImporting}
          >
            <FileUp size={14} />
            <span>Import File</span>
          </button>
          <button
            type="button"
            className={styles.item}
            onClick={() => tagLibraryInputRef.current?.click()}
            disabled={tagLibraryImporting}
          >
            <Tags size={14} />
            <span>{tagLibraryImporting ? 'Importing Tags...' : 'Import TagLibrary JSON'}</span>
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
            <span>Import URL</span>
          </button>
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
