import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import { FormField, TextInput, TextArea } from '@/components/shared/FormComponents'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { LoomItem, LoomItemCategory, CreateLoomItemInput } from '@/types/api'
import clsx from 'clsx'
import styles from './LoomEditorModal.module.css'

const CATEGORIES: { value: LoomItemCategory; label: string }[] = [
  { value: 'narrative_style', label: 'Style' },
  { value: 'loom_utility', label: 'Utility' },
  { value: 'retrofit', label: 'Retrofit' },
]

const CATEGORY_HINTS: Record<LoomItemCategory, string> = {
  narrative_style: 'Define a writing style, tone, or narrative voice for the AI to adopt.',
  loom_utility: 'Create utility instructions that modify AI behavior or add capabilities.',
  retrofit: 'Retrofit content to adjust or transform existing narratives.',
}

const CATEGORY_PLACEHOLDERS: Record<LoomItemCategory, string> = {
  narrative_style: 'Write in a poetic, flowing style with rich metaphors...',
  loom_utility: 'When the user mentions combat, use detailed action descriptions...',
  retrofit: 'Adjust the tone to be more lighthearted and casual...',
}

export default function LoomEditorModal() {
  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)

  const packId = modalProps.packId as string
  const editingItem = modalProps.editingItem as LoomItem | undefined
  const onSaved = modalProps.onSaved as (() => void) | undefined

  const [name, setName] = useState(editingItem?.name || '')
  const [category, setCategory] = useState<LoomItemCategory>(editingItem?.category || 'narrative_style')
  const [content, setContent] = useState(editingItem?.content || '')
  const [authorName, setAuthorName] = useState(editingItem?.author_name || '')
  const [saving, setSaving] = useState(false)
  const [showDiscard, setShowDiscard] = useState(false)

  const initialRef = useRef({
    name: editingItem?.name || '',
    category: editingItem?.category || 'narrative_style',
    content: editingItem?.content || '',
    authorName: editingItem?.author_name || '',
  })

  const isDirty = useCallback(() => {
    const init = initialRef.current
    return name !== init.name || category !== init.category || content !== init.content || authorName !== init.authorName
  }, [name, category, content, authorName])

  const handleClose = useCallback(() => {
    if (isDirty()) {
      setShowDiscard(true)
    } else {
      closeModal()
    }
  }, [isDirty, closeModal])

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [handleClose])

  const handleSave = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      const data: CreateLoomItemInput = {
        name: name.trim(),
        category,
        content: content.trim() || undefined,
        author_name: authorName.trim() || undefined,
      }
      if (editingItem) {
        await packsApi.updateLoomItem(packId, editingItem.id, data)
      } else {
        await packsApi.createLoomItem(packId, data)
      }
      onSaved?.()
      closeModal()
    } catch (err) {
      console.error('Failed to save loom item:', err)
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <>
      <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && handleClose()}>
        <div className={styles.modal}>
          <div className={styles.header}>
            <h3 className={styles.title}>{editingItem ? 'Edit Loom Item' : 'Create Loom Item'}</h3>
            <button type="button" className={styles.closeBtn} onClick={handleClose}>
              <X size={16} />
            </button>
          </div>

          <div className={styles.body}>
            <FormField label="Name" required>
              <TextInput value={name} onChange={setName} placeholder="Item name" autoFocus />
            </FormField>

            <FormField label="Category">
              <div className={styles.categoryTabs}>
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat.value}
                    type="button"
                    className={clsx(styles.categoryTab, category === cat.value && styles.categoryTabActive)}
                    onClick={() => setCategory(cat.value)}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </FormField>

            <FormField label="Content" required hint={CATEGORY_HINTS[category]}>
              <TextArea
                value={content}
                onChange={setContent}
                placeholder={CATEGORY_PLACEHOLDERS[category]}
                rows={6}
              />
            </FormField>

            <FormField label="Author">
              <TextInput value={authorName} onChange={setAuthorName} placeholder="Author name" />
            </FormField>
          </div>

          <div className={styles.footer}>
            <button type="button" className={styles.btnCancel} onClick={handleClose}>Cancel</button>
            <button type="button" className={styles.btnSave} onClick={handleSave} disabled={!name.trim() || saving}>
              {saving ? 'Saving...' : editingItem ? 'Save Changes' : 'Create'}
            </button>
          </div>
        </div>
      </div>

      {showDiscard && (
        <ConfirmationModal
          isOpen
          title="Discard changes?"
          message="You have unsaved changes. Are you sure you want to discard them?"
          variant="warning"
          confirmText="Discard"
          cancelText="Keep editing"
          onConfirm={() => {
            setShowDiscard(false)
            closeModal()
          }}
          onCancel={() => setShowDiscard(false)}
          zIndex={10003}
        />
      )}
    </>,
    document.body
  )
}
