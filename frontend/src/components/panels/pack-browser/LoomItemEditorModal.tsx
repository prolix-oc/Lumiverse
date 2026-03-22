import { useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { X } from 'lucide-react'
import { packsApi } from '@/api/packs'
import type { LoomItem, LoomItemCategory } from '@/types/api'
import styles from './PackBrowser.module.css'

interface Props {
  packId: string
  initialData?: LoomItem
  onSave: () => void
  onClose: () => void
}

const CATEGORIES: { value: LoomItemCategory; label: string }[] = [
  { value: 'narrative_style', label: 'Narrative Style' },
  { value: 'loom_utility', label: 'Loom Utility' },
  { value: 'retrofit', label: 'Retrofit' },
]

export default function LoomItemEditorModal({ packId, initialData, onSave, onClose }: Props) {
  const [name, setName] = useState(initialData?.name || '')
  const [category, setCategory] = useState<LoomItemCategory>(initialData?.category || 'narrative_style')
  const [content, setContent] = useState(initialData?.content || '')
  const [authorName, setAuthorName] = useState(initialData?.author_name || '')
  const [saving, setSaving] = useState(false)

  const isEditing = !!initialData

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const data = { name: name.trim(), category, content, author_name: authorName.trim() }
      if (isEditing) {
        await packsApi.updateLoomItem(packId, initialData.id, data)
      } else {
        await packsApi.createLoomItem(packId, data)
      }
      onSave()
    } catch {
      setSaving(false)
    }
  }

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
          <h2 className={styles.modalTitle}>{isEditing ? 'Edit Loom Item' : 'New Loom Item'}</h2>
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
              placeholder="Item name"
              autoFocus
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Category</label>
            <select
              className={styles.fieldSelect}
              value={category}
              onChange={(e) => setCategory(e.target.value as LoomItemCategory)}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Author</label>
            <input
              type="text"
              className={styles.fieldInput}
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              placeholder="Author name"
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Content</label>
            <textarea
              className={styles.fieldTextarea}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Loom item content / prompt..."
              rows={6}
            />
            <div className={styles.charCount}>{content.length} chars</div>
          </div>
        </div>
        <div className={styles.modalFooter}>
          <button type="button" className={styles.btnCancel} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnSave}
            disabled={!name.trim() || saving}
            onClick={handleSave}
          >
            {saving ? 'Saving...' : isEditing ? 'Save' : 'Create'}
          </button>
        </div>
      </motion.div>
    </div>,
    document.body
  )
}
