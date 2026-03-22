import { useState, useCallback, useRef } from 'react'
import { User, Check, X, Upload } from 'lucide-react'
import useImageCropFlow from '@/hooks/useImageCropFlow'
import ImageCropModal from '@/components/shared/ImageCropModal'
import styles from './CreatePersonaForm.module.css'

interface CreatePersonaFormProps {
  onCreate: (name: string, avatarFile?: File) => Promise<void>
  onCancel: () => void
}

export default function CreatePersonaForm({ onCreate, onCancel }: CreatePersonaFormProps) {
  const [name, setName] = useState('')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleCropComplete = useCallback((file: File) => {
    setAvatarFile(file)
    const url = URL.createObjectURL(file)
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
      await onCreate(name.trim(), avatarFile || undefined)
    } finally {
      setCreating(false)
    }
  }, [name, avatarFile, creating, onCreate])

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
        title="Upload avatar"
      >
        {avatarPreview ? (
          <img src={avatarPreview} alt="Preview" className={styles.avatarPreview} />
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
        placeholder="Persona name..."
        autoFocus
      />
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.confirmBtn}
          onClick={handleSubmit}
          disabled={!name.trim() || creating}
          title="Create"
        >
          <Check size={14} />
        </button>
        <button
          type="button"
          className={styles.cancelBtn}
          onClick={onCancel}
          title="Cancel"
        >
          <X size={14} />
        </button>
      </div>

      <ImageCropModal {...cropModalProps} />
    </div>
  )
}
