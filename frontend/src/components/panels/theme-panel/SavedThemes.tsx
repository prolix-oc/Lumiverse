import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, Check, Pencil, RefreshCw, Trash2, X } from 'lucide-react'
import clsx from 'clsx'
import { useStore } from '@/store'
import type { SavedTheme } from '@/types/store'
import styles from './SavedThemes.module.css'

const CHARACTER_AWARE_SWATCH = 'linear-gradient(135deg, #a78bfa 0%, #f472b6 50%, #38bdf8 100%)'

function swatchForEntry(entry: SavedTheme): string {
  const theme = entry.kind === 'config' ? entry.theme : entry.pack.theme
  if (theme?.characterAware) return CHARACTER_AWARE_SWATCH
  if (theme?.accent) {
    const { h, s, l } = theme.accent
    return `hsl(${h}, ${s}%, ${l}%)`
  }
  return 'var(--lumiverse-primary)'
}

function attributionFor(entry: SavedTheme): string {
  if (entry.kind === 'config') return 'JSON theme'
  const pack = entry.pack
  const parts: string[] = []
  const compCount = Object.keys(pack.components).length
  if (compCount > 0) parts.push(`${compCount} component${compCount === 1 ? '' : 's'}`)
  if (pack.assets.length > 0) parts.push(`${pack.assets.length} asset${pack.assets.length === 1 ? '' : 's'}`)
  if (pack.globalCSS.trim()) parts.push('global CSS')
  return parts.length > 0 ? `Bundle · ${parts.join(', ')}` : 'Bundle'
}

interface SavedThemeCardProps {
  entry: SavedTheme
  isActive: boolean
  autoEdit?: boolean
  onApply: () => void
  onRename: (name: string) => void
  onUpdate: () => void
  onDelete: () => void
}

function SavedThemeCard({ entry, isActive, autoEdit, onApply, onRename, onUpdate, onDelete }: SavedThemeCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.name)

  useEffect(() => {
    if (autoEdit) {
      setEditing(true)
      setDraft(entry.name)
    }
  }, [autoEdit, entry.name])

  const swatch = useMemo(() => swatchForEntry(entry), [entry])
  const attribution = useMemo(() => attributionFor(entry), [entry])

  const commitRename = useCallback(() => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== entry.name) onRename(trimmed)
    else setDraft(entry.name)
    setEditing(false)
  }, [draft, entry.name, onRename])

  const cancelRename = useCallback(() => {
    setDraft(entry.name)
    setEditing(false)
  }, [entry.name])

  return (
    <div
      className={clsx(styles.card, isActive && styles.cardActive)}
      onClick={editing ? undefined : onApply}
      role={editing ? undefined : 'button'}
      tabIndex={editing ? -1 : 0}
      onKeyDown={(e) => {
        if (editing) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onApply()
        }
      }}
    >
      <div className={styles.swatch} style={{ background: swatch }}>
        {isActive && <Check size={12} strokeWidth={3} />}
      </div>
      <div className={styles.info}>
        {editing ? (
          <input
            className={styles.nameInput}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') cancelRename()
            }}
            maxLength={200}
          />
        ) : (
          <span className={styles.name}>{entry.name}</span>
        )}
        <span className={styles.attribution}>{attribution}</span>
      </div>
      <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
        {editing ? (
          <>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={commitRename}
              title="Save name"
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={cancelRename}
              title="Cancel"
            >
              <X size={12} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => setEditing(true)}
              title="Rename"
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onUpdate}
              title="Update with current theme"
            >
              <RefreshCw size={12} />
            </button>
            <button
              type="button"
              className={clsx(styles.iconBtn, styles.deleteBtn)}
              onClick={onDelete}
              title="Delete saved theme"
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default function SavedThemes() {
  const savedThemes = useStore((s) => s.savedThemes)
  const applySavedTheme = useStore((s) => s.applySavedTheme)
  const renameSavedTheme = useStore((s) => s.renameSavedTheme)
  const deleteSavedTheme = useStore((s) => s.deleteSavedTheme)
  const updateSavedTheme = useStore((s) => s.updateSavedTheme)
  const openModal = useStore((s) => s.openModal)
  const activeBundleId = useStore((s) => s.customCSS.bundleId)
  const activeThemeId = useStore((s) => s.theme?.id ?? '')

  const prevLengthRef = useRef(savedThemes.length)
  const [newlyAddedId, setNewlyAddedId] = useState<string | null>(null)

  useEffect(() => {
    const prevLen = prevLengthRef.current
    prevLengthRef.current = savedThemes.length
    if (savedThemes.length > prevLen && savedThemes.length > 0) {
      setNewlyAddedId(savedThemes[savedThemes.length - 1].id)
    }
  }, [savedThemes])

  const handleDelete = (entry: SavedTheme) => {
    openModal('confirm', {
      title: 'Delete saved theme',
      message: `Remove "${entry.name}" from My Themes? ${
        entry.kind === 'pack' ? 'Bundled assets will be cleaned up unless this theme is currently active.' : 'This cannot be undone.'
      }`,
      variant: 'danger',
      confirmText: 'Delete',
      onConfirm: () => {
        void deleteSavedTheme(entry.id)
      },
    })
  }

  const handleUpdate = (entry: SavedTheme) => {
    openModal('confirm', {
      title: 'Update saved theme',
      message: `Overwrite "${entry.name}" with your current theme settings? The previous snapshot will be lost.`,
      variant: 'danger',
      confirmText: 'Update',
      onConfirm: () => {
        updateSavedTheme(entry.id)
      },
    })
  }

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <span className={styles.headerIcon}><Bookmark size={12} /></span>
        <h4 className={styles.headerLabel}>My Themes</h4>
      </div>
      {savedThemes.length === 0 ? (
        <p className={styles.emptyHint}>
          Save your current theme to quickly switch between favorites.
        </p>
      ) : (
        <div className={styles.list}>
          {savedThemes.map((entry) => {
            const isActive =
              entry.kind === 'pack'
                ? !!activeBundleId && activeBundleId === entry.pack.bundleId
                : activeThemeId === entry.theme.id && activeThemeId !== 'custom'
            return (
              <SavedThemeCard
                key={entry.id}
                entry={entry}
                isActive={isActive}
                autoEdit={entry.id === newlyAddedId}
                onApply={() => applySavedTheme(entry.id)}
                onRename={(name) => renameSavedTheme(entry.id, name)}
                onUpdate={() => handleUpdate(entry)}
                onDelete={() => handleDelete(entry)}
              />
            )
          })}
        </div>
      )}
    </section>
  )
}
