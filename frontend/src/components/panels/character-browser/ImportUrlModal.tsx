import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { Spinner } from '@/components/shared/Spinner'
import { CloseButton } from '@/components/shared/CloseButton'
import styles from './ImportUrlModal.module.css'

interface ImportUrlModalProps {
  isOpen: boolean
  onClose: () => void
  onImport: (urls: string) => Promise<void>
  loading: boolean
  error: string | null
}

export default function ImportUrlModal({
  isOpen,
  onClose,
  onImport,
  loading,
  error,
}: ImportUrlModalProps) {
  const { t } = useTranslation('panels')
  const [urls, setUrls] = useState('')
  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!urls.trim() || loading) return
    try {
      await onImport(urls.trim())
      setUrls('')
      onClose()
    } catch {
      // Error is displayed via the error prop
    }
  }

  return createPortal(
    <div className={styles.overlay} onMouseDown={(e) => { mouseDownTargetRef.current = e.target }} onClick={(e) => e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h3 className={styles.title}>{t('characterBrowser.importFromUrlTitle')}</h3>
          <CloseButton onClick={onClose} />
        </div>
        <form onSubmit={handleSubmit}>
          <p className={styles.hint}>
            {t('characterBrowser.importFromUrlHint')}
          </p>
          <textarea
            className={styles.input}
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder={t('characterBrowser.importUrlPlaceholder')}
            autoFocus
            disabled={loading}
            rows={5}
          />
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={loading}>
              {t('characterBrowser.cancel')}
            </button>
            <button type="submit" className={styles.importBtn} disabled={!urls.trim() || loading}>
              {loading ? <Spinner size={14} /> : null}
              {t('characterBrowser.import')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
