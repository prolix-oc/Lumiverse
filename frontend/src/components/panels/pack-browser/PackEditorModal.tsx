import { useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { X } from 'lucide-react'
import type { Pack } from '@/types/api'
import styles from './PackBrowser.module.css'

interface Props {
  initialData?: Pack
  onSave: (data: { name: string; author: string; cover_url: string }) => void
  onClose: () => void
}

export default function PackEditorModal({ initialData, onSave, onClose }: Props) {
  const [name, setName] = useState(initialData?.name || '')
  const [author, setAuthor] = useState(initialData?.author || '')
  const [coverUrl, setCoverUrl] = useState(initialData?.cover_url || '')

  const isEditing = !!initialData

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <motion.div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.15 }}
      >
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>{isEditing ? 'Edit Pack' : 'New Pack'}</h2>
          <button type="button" className={styles.modalCloseBtn} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Name *</label>
            <input
              type="text"
              className={styles.fieldInput}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Pack"
              autoFocus
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Author</label>
            <input
              type="text"
              className={styles.fieldInput}
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Your name"
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Cover Image URL</label>
            <input
              type="text"
              className={styles.fieldInput}
              value={coverUrl}
              onChange={(e) => setCoverUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>
        </div>
        <div className={styles.modalFooter}>
          <button type="button" className={styles.btnCancel} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnSave}
            disabled={!name.trim()}
            onClick={() => onSave({ name: name.trim(), author: author.trim(), cover_url: coverUrl.trim() })}
          >
            {isEditing ? 'Save' : 'Create'}
          </button>
        </div>
      </motion.div>
    </div>,
    document.body
  )
}
