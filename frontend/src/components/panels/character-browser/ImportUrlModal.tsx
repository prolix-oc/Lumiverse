import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2 } from 'lucide-react'
import styles from './ImportUrlModal.module.css'

interface ImportUrlModalProps {
  isOpen: boolean
  onClose: () => void
  onImport: (url: string) => Promise<void>
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
  const [url, setUrl] = useState('')
  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim() || loading) return
    try {
      await onImport(url.trim())
      setUrl('')
      onClose()
    } catch {
      // Error is displayed via the error prop
    }
  }

  return createPortal(
    <div className={styles.overlay} onMouseDown={(e) => { mouseDownTargetRef.current = e.target }} onClick={(e) => e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h3 className={styles.title}>Import from URL</h3>
          <button type="button" className={styles.closeBtn} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <p className={styles.hint}>
            Paste a character URL from Chub, JannyAI, or other supported sources.
          </p>
          <input
            type="url"
            className={styles.input}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://chub.ai/characters/..."
            autoFocus
            disabled={loading}
          />
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className={styles.importBtn} disabled={!url.trim() || loading}>
              {loading ? <Loader2 size={14} className={styles.spinner} /> : null}
              Import
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
