import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import { FormField, TextInput, TextArea, Select, ImageInput } from '@/components/shared/FormComponents'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { LumiaItem, CreateLumiaItemInput } from '@/types/api'
import styles from './LumiaEditorModal.module.css'

const GENDER_OPTIONS = [
  { value: '0', label: 'Neutral' },
  { value: '1', label: 'Feminine' },
  { value: '2', label: 'Masculine' },
]

export default function LumiaEditorModal() {
  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)

  const packId = modalProps.packId as string
  const editingItem = modalProps.editingItem as LumiaItem | undefined
  const onSaved = modalProps.onSaved as (() => void) | undefined

  const [name, setName] = useState(editingItem?.name || '')
  const [avatarUrl, setAvatarUrl] = useState(editingItem?.avatar_url || '')
  const [authorName, setAuthorName] = useState(editingItem?.author_name || '')
  const [genderIdentity, setGenderIdentity] = useState(String(editingItem?.gender_identity ?? 0))
  const [definition, setDefinition] = useState(editingItem?.definition || '')
  const [personality, setPersonality] = useState(editingItem?.personality || '')
  const [behavior, setBehavior] = useState(editingItem?.behavior || '')
  const [saving, setSaving] = useState(false)
  const [showDiscard, setShowDiscard] = useState(false)

  const initialRef = useRef({
    name: editingItem?.name || '',
    avatarUrl: editingItem?.avatar_url || '',
    authorName: editingItem?.author_name || '',
    genderIdentity: String(editingItem?.gender_identity ?? 0),
    definition: editingItem?.definition || '',
    personality: editingItem?.personality || '',
    behavior: editingItem?.behavior || '',
  })

  const isDirty = useCallback(() => {
    const init = initialRef.current
    return (
      name !== init.name ||
      avatarUrl !== init.avatarUrl ||
      authorName !== init.authorName ||
      genderIdentity !== init.genderIdentity ||
      definition !== init.definition ||
      personality !== init.personality ||
      behavior !== init.behavior
    )
  }, [name, avatarUrl, authorName, genderIdentity, definition, personality, behavior])

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
      const data: CreateLumiaItemInput = {
        name: name.trim(),
        avatar_url: avatarUrl.trim() || undefined,
        author_name: authorName.trim() || undefined,
        gender_identity: Number(genderIdentity) as 0 | 1 | 2,
        definition: definition.trim() || undefined,
        personality: personality.trim() || undefined,
        behavior: behavior.trim() || undefined,
      }
      if (editingItem) {
        await packsApi.updateLumiaItem(packId, editingItem.id, data)
      } else {
        await packsApi.createLumiaItem(packId, data)
      }
      onSaved?.()
      closeModal()
    } catch (err) {
      console.error('Failed to save lumia item:', err)
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <>
      <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && handleClose()}>
        <div className={styles.modal}>
          <div className={styles.header}>
            <h3 className={styles.title}>{editingItem ? 'Edit Lumia' : 'Create Lumia'}</h3>
            <button type="button" className={styles.closeBtn} onClick={handleClose}>
              <X size={16} />
            </button>
          </div>

          <div className={styles.body}>
            <FormField label="Name" required>
              <TextInput value={name} onChange={setName} placeholder="Character name" autoFocus />
            </FormField>

            <FormField label="Avatar URL">
              <ImageInput value={avatarUrl} onChange={setAvatarUrl} placeholder="https://..." />
            </FormField>

            <div className={styles.row}>
              <div className={styles.rowHalf}>
                <FormField label="Author">
                  <TextInput value={authorName} onChange={setAuthorName} placeholder="Author name" />
                </FormField>
              </div>
              <div className={styles.rowHalf}>
                <FormField label="Gender Identity">
                  <Select value={genderIdentity} onChange={setGenderIdentity} options={GENDER_OPTIONS} />
                </FormField>
              </div>
            </div>

            <FormField label="Definition" hint="Physical description, appearance, backstory">
              <TextArea value={definition} onChange={setDefinition} placeholder="Describe the character's physical traits, appearance, and background..." rows={4} />
            </FormField>

            <FormField label="Personality" hint="Core personality traits and temperament">
              <TextArea value={personality} onChange={setPersonality} placeholder="Describe the character's personality..." rows={3} />
            </FormField>

            <FormField label="Behavior" hint="How the character acts and speaks">
              <TextArea value={behavior} onChange={setBehavior} placeholder="Describe the character's behavior patterns and speech style..." rows={3} />
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
