import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { Plus, X, Pencil, Check, Link2, Image as ImageIcon } from 'lucide-react'
import { imagesApi } from '@/api/images'
import type { CharacterGalleryItem } from '@/types/api'
import LazyImage from '@/components/shared/LazyImage'
import ImageCropModal from '@/components/shared/ImageCropModal'
import CharacterGalleryPicker from './CharacterGalleryPicker'
import styles from './AlternateAvatarManager.module.css'
import clsx from 'clsx'
import {
  AVATAR_BINDING_FIELDS,
  PRIMARY_AVATAR_ENTRY_ID,
  type AvatarBindingField,
  type AvatarBindings,
  type AlternateAvatarEntry,
} from '@/lib/avatarBindings'

export type { AlternateAvatarEntry } from '@/lib/avatarBindings'

interface Props {
  characterId: string
  primaryImageId: string | null
  alternates: AlternateAvatarEntry[]
  onChange: (alternates: AlternateAvatarEntry[]) => void
  bindings: AvatarBindings
  alternateFields: Record<string, Array<{ id: string; label: string; content: string }>>
  greetingCount: number
  onBindingsChange: (bindings: AvatarBindings) => void
  openCropFlow: (file: File) => void
  onGalleryCropComplete: (file: File, source: CharacterGalleryItem) => void
  /** When provided, tapping an avatar selects it for the active chat. */
  activeChatAvatarId?: string | null
  onAvatarSelect?: (avatarEntryId: string) => void
  /** Upload progress (0-100) for a new alternate avatar being uploaded. */
  uploadProgress?: number | null
}

export default function AlternateAvatarManager({
  characterId,
  primaryImageId,
  alternates,
  onChange,
  bindings,
  alternateFields,
  greetingCount,
  onBindingsChange,
  openCropFlow,
  onGalleryCropComplete,
  activeChatAvatarId,
  onAvatarSelect,
  uploadProgress = null,
}: Props) {
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [bindingEditorId, setBindingEditorId] = useState<string | null>(null)
  const [showGalleryPicker, setShowGalleryPicker] = useState(false)
  const [galleryCropSource, setGalleryCropSource] = useState<CharacterGalleryItem | null>(null)
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
      if (bindings[entryId]) {
        const next = { ...bindings }
        delete next[entryId]
        onBindingsChange(next)
      }
      if (renamingId === entryId) setRenamingId(null)
      if (bindingEditorId === entryId) setBindingEditorId(null)
    },
    [alternates, bindingEditorId, bindings, onBindingsChange, onChange, renamingId]
  )

  const setBindingValue = useCallback((avatarId: string, key: AvatarBindingField | 'greeting_index', raw: string) => {
    const next: AvatarBindings = Object.fromEntries(
      Object.entries(bindings).map(([id, binding]) => [id, { ...binding }]),
    )
    const current = { ...(next[avatarId] || {}) }
    if (raw === '__unchanged__') {
      delete current[key]
    } else {
      const value = key === 'greeting_index'
        ? Number(raw)
        : raw === '__default__' ? null : raw
      current[key] = value as never
      for (const [otherId, otherBinding] of Object.entries(next)) {
        if (otherId === avatarId || otherBinding[key] !== value) continue
        delete otherBinding[key]
        if (Object.keys(otherBinding).length === 0) delete next[otherId]
      }
    }
    if (Object.keys(current).length > 0) next[avatarId] = current
    else delete next[avatarId]
    onBindingsChange(next)
  }, [bindings, onBindingsChange])

  const renderBindingEditor = (avatarId: string) => {
    if (bindingEditorId !== avatarId) return null
    const binding = bindings[avatarId] || {}
    return (
      <div className={styles.bindingEditor}>
        <span className={styles.bindingTitle}>{t('characterBrowser.alternateAvatars.bindings')}</span>
        {AVATAR_BINDING_FIELDS.map((field) => {
          const variants = alternateFields[field] || []
          if (variants.length === 0) return null
          const value = Object.prototype.hasOwnProperty.call(binding, field)
            ? binding[field] === null ? '__default__' : binding[field]
            : '__unchanged__'
          return (
            <label key={field} className={styles.bindingRow}>
              <span>{field}</span>
              <select value={value ?? '__unchanged__'} onChange={(event) => setBindingValue(avatarId, field, event.target.value)}>
                <option value="__unchanged__">{t('characterBrowser.alternateAvatars.keepCurrent')}</option>
                <option value="__default__">{t('characterBrowser.alternateAvatars.default')}</option>
                {variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.label}</option>)}
              </select>
            </label>
          )
        })}
        {greetingCount > 0 && (
          <label className={styles.bindingRow}>
            <span>{t('characterBrowser.alternateAvatars.greeting')}</span>
            <select
              value={Object.prototype.hasOwnProperty.call(binding, 'greeting_index') ? String(binding.greeting_index ?? 0) : '__unchanged__'}
              onChange={(event) => setBindingValue(avatarId, 'greeting_index', event.target.value)}
            >
              <option value="__unchanged__">{t('characterBrowser.alternateAvatars.keepCurrent')}</option>
              <option value="0">{t('characterBrowser.alternateAvatars.default')}</option>
              {Array.from({ length: Math.max(0, greetingCount - 1) }, (_, index) => (
                <option key={index + 1} value={index + 1}>{t('characterBrowser.alternateAvatars.greetingNumber', { number: index + 1 })}</option>
              ))}
            </select>
          </label>
        )}
      </div>
    )
  }

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
        <span className={styles.label}>{t('characterBrowser.alternateAvatars.title')}</span>
        <span className={styles.helper}>{t('characterBrowser.alternateAvatars.helper')}</span>
        {selectable && (
          <span className={styles.selectionHint}>{t('characterBrowser.alternateAvatars.selectionHint')}</span>
        )}
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.controlBtn}
          onClick={() => setShowGalleryPicker(true)}
          disabled={uploadProgress !== null}
        >
          <ImageIcon size={14} /> {t('characterBrowser.alternateAvatars.addFromGallery')}
        </button>
      </div>

      <div className={styles.strip}>
        {/* Primary avatar (non-deletable) */}
        {primaryImageId && (
          <div
            className={clsx(styles.avatarCard, selectable && styles.avatarCardSelectable)}
            onClick={selectable ? () => onAvatarSelect!(PRIMARY_AVATAR_ENTRY_ID) : undefined}
          >
            <LazyImage
              src={imagesApi.smallUrl(primaryImageId)}
              alt={t('characterBrowser.alternateAvatars.primary')}
              className={clsx(
                styles.thumb,
                selectable && !activeChatAvatarId && styles.thumbSelected
              )}
              fallback={<div className={styles.thumbPlaceholder} />}
            />
            <span className={styles.avatarLabel}>{t('characterBrowser.alternateAvatars.primary')}</span>
            <button type="button" className={styles.bindingBtn} onClick={(event) => { event.stopPropagation(); setBindingEditorId((id) => id === PRIMARY_AVATAR_ENTRY_ID ? null : PRIMARY_AVATAR_ENTRY_ID) }}>
              <Link2 size={10} /> {Object.keys(bindings[PRIMARY_AVATAR_ENTRY_ID] || {}).length || ''}
            </button>
          </div>
        )}

        {/* Alternate avatars */}
        {alternates.map((entry) => {
          const isSelected = selectable && activeChatAvatarId === entry.image_id

          return (
            <div
              key={entry.id}
              className={clsx(styles.avatarCard, selectable && styles.avatarCardSelectable)}
              onClick={selectable ? () => onAvatarSelect!(entry.id) : undefined}
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
                <button
                  type="button"
                  className={styles.avatarLabelButton}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleStartRename(entry)
                  }}
                  title={tc('actions.edit')}
                  aria-label={`${tc('actions.edit')}: ${entry.label}`}
                >
                  <span className={styles.avatarLabel}>{entry.label}</span>
                  <Pencil className={styles.labelEditIcon} size={10} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className={styles.bindingBtn}
                onClick={(event) => {
                  event.stopPropagation()
                  setBindingEditorId((id) => id === entry.id ? null : entry.id)
                }}
                title={t('characterBrowser.alternateAvatars.linkFields')}
              >
                <Link2 size={10} /> {Object.keys(bindings[entry.id] || {}).length || ''}
              </button>
              <div className={styles.cardActions} onClick={(e) => e.stopPropagation()}>
                <button type="button" className={styles.iconBtn} onClick={() => handleDelete(entry.id)} title={tc('actions.delete')}>
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
            <span className={styles.avatarLabel}>{t('characterBrowser.alternateAvatars.uploading')}</span>
          </div>
        )}

        {/* Add button */}
        <button
          type="button"
          className={styles.addCard}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadProgress !== null}
          title={t('characterBrowser.alternateAvatars.uploadImage')}
          aria-label={t('characterBrowser.alternateAvatars.uploadImage')}
        >
          <Plus size={16} />
        </button>
      </div>

      {bindingEditorId && renderBindingEditor(bindingEditorId)}

      {showGalleryPicker && (
        <CharacterGalleryPicker
          characterId={characterId}
          onClose={() => setShowGalleryPicker(false)}
          onSelect={(item) => {
            setShowGalleryPicker(false)
            setGalleryCropSource(item)
          }}
        />
      )}
      <ImageCropModal
        isOpen={galleryCropSource !== null}
        imageSrc={galleryCropSource ? imagesApi.url(galleryCropSource.image_id) : null}
        onCancel={() => setGalleryCropSource(null)}
        onCropDone={(blob) => {
          if (!galleryCropSource) return
          onGalleryCropComplete(new File([blob], 'avatar.png', { type: 'image/png' }), galleryCropSource)
          setGalleryCropSource(null)
        }}
      />

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
