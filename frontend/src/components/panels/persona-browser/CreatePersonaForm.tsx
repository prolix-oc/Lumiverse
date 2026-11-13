import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { User, Check, X, Upload } from 'lucide-react'
import useImageCropFlow from '@/hooks/useImageCropFlow'
import ImageCropModal from '@/components/shared/ImageCropModal'
import styles from './CreatePersonaForm.module.css'

interface CreatePersonaFormProps {
  onCreate: (name: string, avatarFile?: File, originalFile?: File) => Promise<void>
  onCancel: () => void
}

export default function CreatePersonaForm({
  onCreate, onCancel }: CreatePersonaFormProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'personaManager.createForm' })
  const { t: tc } = useTranslation('common')
  const [name, setName] = useState('')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [originalFile, setOriginalFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleCropComplete = useCallback((croppedFile: File, origFile: File) => {
    setAvatarFile(croppedFile)
    setOriginalFile(origFile)
    const url = URL.createObjectURL(croppedFile)
    setAvatarPreview(url)
  }, [])

  const { cropModalProps, openCropFlow } = useImageCropFlow(handleCropComplete)

  const handleFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) openCropFlow(file)
      e.target.value = ''
    },
    [openCropFlow]
  )

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || creating) return
    setCreating(true)
    try {
      await onCreate(name.trim(), avatarFile || undefined, originalFile || undefined)
    } finally {
      setCreating(false)
    }
  }, [name, avatarFile, originalFile, creating, onCreate])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSubmit()
      if (e.key === 'Escape') onCancel()
    },
    [handleSubmit, onCancel]
  )

  return (
    <div className={styles.form}>
      <div
        className={styles.avatarArea}
        onClick={() => fileRef.current?.click()}
        title={t('uploadAvatar')}
      >
        {avatarPreview ? (
          <img src={avatarPreview} alt={t('previewAlt')} className={styles.avatarPreview} />
        ) : (
          <div className={styles.avatarPlaceholder}>
            <Upload size={16} />
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className={styles.hiddenInput}
          onChange={handleFileSelected}
        />
      </div>
      <input
        type="text"
        className={styles.nameInput}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('namePlaceholder')}
        autoFocus
      />
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.confirmBtn}
          onClick={handleSubmit}
          disabled={!name.trim() || creating}
          title={t('create')}
        >
          <Check size={14} />
        </button>
        <button
          type="button"
          className={styles.cancelBtn}
          onClick={onCancel}
          title={tc('actions.cancel')}
        >
          <X size={14} />
        </button>
      </div>

      <ImageCropModal {...cropModalProps} />
    </div>
  )
}
