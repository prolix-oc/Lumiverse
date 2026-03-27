import { useState, useCallback, useRef, useEffect } from 'react'
import { Plus, X, Pencil, Check } from 'lucide-react'
import { imagesApi } from '@/api/images'
import LazyImage from '@/components/shared/LazyImage'
import styles from './AlternateAvatarManager.module.css'
import clsx from 'clsx'

export interface AlternateAvatarEntry {
  id: string
  image_id: string
  original_image_id?: string
  label: string
}

interface Props {
  primaryImageId: string | null
  alternates: AlternateAvatarEntry[]
  onChange: (alternates: AlternateAvatarEntry[]) => void
  openCropFlow: (file: File) => void
  /** When provided, tapping an avatar selects it for the active chat. */
  activeChatAvatarId?: string | null
  onAvatarSelect?: (imageId: string | null) => void
  /** Upload progress (0-100) for a new alternate avatar being uploaded. */
  uploadProgress?: number | null
}

export default function AlternateAvatarManager({
  primaryImageId,
  alternates,
  onChange,
  openCropFlow,
  activeChatAvatarId,
  onAvatarSelect,
  uploadProgress,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  const selectable = !!onAvatarSelect

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  const handleFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) openCropFlow(file)
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [openCropFlow]
  )

  const handleDelete = useCallback(
    (entryId: string) => {
      onChange(alternates.filter((a) => a.id !== entryId))
      if (renamingId === entryId) setRenamingId(null)
    },
    [alternates, onChange, renamingId]
  )

  const handleStartRename = useCallback((entry: AlternateAvatarEntry) => {
    setRenamingId(entry.id)
    setRenameValue(entry.label)
  }, [])

  const handleFinishRename = useCallback(() => {
    if (!renamingId) return
    const trimmed = renameValue.trim()
    if (trimmed) {
      onChange(alternates.map((a) => (a.id === renamingId ? { ...a, label: trimmed } : a)))
    }
    setRenamingId(null)
  }, [renamingId, renameValue, alternates, onChange])

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.label}>Alternate Avatars</span>
        <span className={styles.helper}>Additional profile pictures for this character, switchable per chat.</span>
        {selectable && (
          <span className={styles.selectionHint}>Tap an avatar to use it in this chat.</span>
        )}
      </div>

      <div className={styles.strip}>
        {/* Primary avatar (non-deletable) */}
        {primaryImageId && (
          <div
            className={clsx(styles.avatarCard, selectable && styles.avatarCardSelectable)}
            onClick={selectable ? () => onAvatarSelect!(null) : undefined}
          >
            <LazyImage
              src={imagesApi.smallUrl(primaryImageId)}
              alt="Primary"
              className={clsx(
                styles.thumb,
                selectable && !activeChatAvatarId && styles.thumbSelected
              )}
              fallback={<div className={styles.thumbPlaceholder} />}
            />
            <span className={styles.avatarLabel}>Primary</span>
          </div>
        )}

        {/* Alternate avatars */}
        {alternates.map((entry) => {
          const isSelected = selectable && activeChatAvatarId === entry.image_id

          return (
            <div
              key={entry.id}
              className={clsx(styles.avatarCard, selectable && styles.avatarCardSelectable)}
              onClick={selectable ? () => onAvatarSelect!(entry.image_id) : undefined}
            >
              <LazyImage
                src={imagesApi.smallUrl(entry.image_id)}
                alt={entry.label}
                className={clsx(styles.thumb, isSelected && styles.thumbSelected)}
                fallback={<div className={styles.thumbPlaceholder} />}
              />
              {renamingId === entry.id ? (
                <div className={styles.renameRow} onClick={(e) => e.stopPropagation()}>
                  <input
                    ref={renameInputRef}
                    className={styles.renameInput}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={handleFinishRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleFinishRename()
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                  />
                  <button type="button" className={styles.iconBtn} onClick={(e) => { e.stopPropagation(); handleFinishRename() }}>
                    <Check size={10} />
                  </button>
                </div>
              ) : (
                <span className={styles.avatarLabel}>{entry.label}</span>
              )}
              <div className={styles.cardActions} onClick={(e) => e.stopPropagation()}>
                <button type="button" className={styles.iconBtn} onClick={() => handleStartRename(entry)} title="Rename">
                  <Pencil size={10} />
                </button>
                <button type="button" className={styles.iconBtn} onClick={() => handleDelete(entry.id)} title="Remove">
                  <X size={10} />
                </button>
              </div>
            </div>
          )
        })}

        {/* Upload progress card */}
        {uploadProgress !== null && (
          <div className={styles.avatarCard}>
            <div className={styles.uploadingThumb}>
              <div className={styles.uploadFill} style={{ transform: `scaleY(${uploadProgress / 100})` }} />
              <span className={styles.uploadPercent}>{uploadProgress}%</span>
            </div>
            <span className={styles.avatarLabel}>Uploading...</span>
          </div>
        )}

        {/* Add button */}
        <button
          type="button"
          className={styles.addCard}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadProgress !== null}
        >
          <Plus size={16} />
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelected}
        style={{ display: 'none' }}
      />
    </div>
  )
}
