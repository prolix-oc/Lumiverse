import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, FolderOpen, Plus, Check, X } from 'lucide-react'
import clsx from 'clsx'
import styles from './FolderDropdown.module.css'
import { clearSearchOnEscape } from '@/lib/clearableSearch'

interface FolderDropdownProps {
  folders: string[]
  selectedFolder: string
  onSelect: (folder: string) => void
  onCreateFolder: (name: string) => void
  placeholder?: string
  className?: string
}

export default function FolderDropdown({
  folders,
  selectedFolder,
  onSelect,
  onCreateFolder,
  placeholder,
  className,
}: FolderDropdownProps) {
  const { t } = useTranslation('shared', { keyPrefix: 'folderDropdown' })
  const resolvedPlaceholder = placeholder ?? t('noFolder')
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const wrapperRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = folders.filter((f) => f.toLowerCase().includes(search.toLowerCase()))

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
        setNewName('')
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  useEffect(() => {
    if (creating && inputRef.current) {
      inputRef.current.focus()
    }
  }, [creating])

  const handleConfirmCreate = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    // Reserved: matches the "Uncategorized" bucket label used by grouped selectors.
    if (trimmed.toLowerCase() === 'uncategorized') return
    onCreateFolder(trimmed)
    onSelect(trimmed)
    setCreating(false)
    setNewName('')
    setOpen(false)
  }

  return (
    <div className={clsx(styles.wrapper, className)} ref={wrapperRef}>
      <button
        type="button"
        className={clsx(styles.trigger, open && styles.triggerOpen)}
        onClick={() => setOpen(!open)}
      >
        <FolderOpen size={12} />
        <span className={clsx(styles.triggerLabel, !selectedFolder && styles.triggerPlaceholder)}>
          {selectedFolder || resolvedPlaceholder}
        </span>
        <span className={clsx(styles.triggerChevron, open && styles.triggerChevronOpen)}>
          <ChevronDown size={12} />
        </span>
      </button>

      {open && (
        <div className={styles.dropdown}>
          {folders.length > 5 && (
            <div className={styles.searchBox}>
              <input
                className={styles.searchInput}
                placeholder={t('searchFolders')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => clearSearchOnEscape(e, search, () => setSearch(''))}
                autoFocus
              />
              {search && (
                <button type="button" className={styles.searchClear} onClick={() => setSearch('')} aria-label={t('searchFolders')}>
                  <X size={12} />
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            className={clsx(styles.option, !selectedFolder && styles.optionActive)}
            onClick={() => {
              onSelect('')
              setOpen(false)
              setSearch('')
            }}
          >
            {t('none')}
          </button>

          {filtered.map((folder) => (
            <button
              key={folder}
              type="button"
              className={clsx(styles.option, folder === selectedFolder && styles.optionActive)}
              onClick={() => {
                onSelect(folder)
                setOpen(false)
                setSearch('')
              }}
            >
              {folder}
            </button>
          ))}

          {creating ? (
            <div className={clsx(styles.option, styles.createRow)}>
              <input
                ref={inputRef}
                className={styles.createInput}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirmCreate()
                  if (e.key === 'Escape') {
                    setCreating(false)
                    setNewName('')
                  }
                }}
                placeholder={t('folderNamePlaceholder')}
                maxLength={64}
              />
              <button
                type="button"
                className={styles.createBtn}
                onClick={handleConfirmCreate}
                disabled={!newName.trim() || newName.trim().toLowerCase() === 'uncategorized'}
              >
                <Check size={12} />
              </button>
              <button
                type="button"
                className={styles.createBtn}
                onClick={() => {
                  setCreating(false)
                  setNewName('')
                }}
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={clsx(styles.option, styles.createOption)}
              onClick={() => setCreating(true)}
            >
              <Plus size={12} /> {t('createNew')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
