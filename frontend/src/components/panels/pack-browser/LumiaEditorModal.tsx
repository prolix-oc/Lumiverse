import { useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { X } from 'lucide-react'
import { packsApi } from '@/api/packs'
import type { LumiaItem } from '@/types/api'
import styles from './PackBrowser.module.css'

interface Props {
  packId: string
  initialData?: LumiaItem
  onSave: () => void
  onClose: () => void
}

export default function LumiaEditorModal({ packId, initialData, onSave, onClose }: Props) {
  const [name, setName] = useState(initialData?.name || '')
  const [authorName, setAuthorName] = useState(initialData?.author_name || '')
  const [avatarUrl, setAvatarUrl] = useState(initialData?.avatar_url || '')
  const [genderIdentity, setGenderIdentity] = useState<0 | 1 | 2>(initialData?.gender_identity ?? 0)
  const [definition, setDefinition] = useState(initialData?.definition || '')
  const [personality, setPersonality] = useState(initialData?.personality || '')
  const [behavior, setBehavior] = useState(initialData?.behavior || '')
  const [saving, setSaving] = useState(false)

  const isEditing = !!initialData

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const data = {
        name: name.trim(),
        author_name: authorName.trim(),
        avatar_url: avatarUrl.trim() || undefined,
        gender_identity: genderIdentity,
        definition,
        personality,
        behavior,
      }
      if (isEditing) {
        await packsApi.updateLumiaItem(packId, initialData.id, data)
      } else {
        await packsApi.createLumiaItem(packId, data)
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
          <h2 className={styles.modalTitle}>{isEditing ? 'Edit Character' : 'New Character'}</h2>
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
              placeholder="Character name"
              autoFocus
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Gender Identity</label>
            <select
              className={styles.fieldSelect}
              value={genderIdentity}
              onChange={(e) => setGenderIdentity(Number(e.target.value) as 0 | 1 | 2)}
            >
              <option value={0}>Unspecified</option>
              <option value={1}>Feminine</option>
              <option value={2}>Masculine</option>
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
            <label className={styles.fieldLabel}>Avatar URL</label>
            <input
              type="text"
              className={styles.fieldInput}
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Definition</label>
            <textarea
              className={styles.fieldTextarea}
              value={definition}
              onChange={(e) => setDefinition(e.target.value)}
              placeholder="Character definition / description..."
              rows={4}
            />
            <div className={styles.charCount}>{definition.length} chars</div>
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Personality</label>
            <textarea
              className={styles.fieldTextarea}
              value={personality}
              onChange={(e) => setPersonality(e.target.value)}
              placeholder="Personality traits..."
              rows={3}
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Behavior</label>
            <textarea
              className={styles.fieldTextarea}
              value={behavior}
              onChange={(e) => setBehavior(e.target.value)}
              placeholder="Behavior instructions..."
              rows={3}
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
