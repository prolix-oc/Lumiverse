import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import { FormField, TextInput, TextArea, Select, ImageInput, Button } from '@/components/shared/FormComponents'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { LumiaItem, CreateLumiaItemInput } from '@/types/api'
import styles from './LumiaEditorModal.module.css'

export default function LumiaEditorModal() {
  const { t } = useTranslation('panels')
  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)

  const packId = modalProps.packId as string
  const editingItem = modalProps.editingItem as LumiaItem | undefined
  const onSaved = modalProps.onSaved as (() => void) | undefined

  const genderOptions = useMemo(() => [
    { value: '0', label: t('creatorWorkshop.shared.gender.feminine') },
    { value: '1', label: t('creatorWorkshop.shared.gender.masculine') },
    { value: '2', label: t('creatorWorkshop.shared.gender.neutral') },
    { value: '3', label: t('creatorWorkshop.shared.gender.any') },
  ], [t])

  const [name, setName] = useState(editingItem?.name || '')
  const [avatarUrl, setAvatarUrl] = useState(editingItem?.avatar_url || '')
  const [authorName, setAuthorName] = useState(editingItem?.author_name || '')
  const [genderIdentity, setGenderIdentity] = useState(String(editingItem?.gender_identity ?? 3))
  const [definition, setDefinition] = useState(editingItem?.definition || '')
  const [personality, setPersonality] = useState(editingItem?.personality || '')
  const [behavior, setBehavior] = useState(editingItem?.behavior || '')
  const [saving, setSaving] = useState(false)
  const [showDiscard, setShowDiscard] = useState(false)

  const initialRef = useRef({
    name: editingItem?.name || '',
    avatarUrl: editingItem?.avatar_url || '',
    authorName: editingItem?.author_name || '',
    genderIdentity: String(editingItem?.gender_identity ?? 3),
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
        gender_identity: Number(genderIdentity) as 0 | 1 | 2 | 3,
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

  return (
    <>
      <ModalShell isOpen onClose={handleClose} maxWidth={640} maxHeight="90vh" closeOnEscape={false} className={styles.modal}>
        <div className={styles.header}>
          <h3 className={styles.title}>
            {editingItem ? t('creatorWorkshop.lumiaEditor.editTitle') : t('creatorWorkshop.lumiaEditor.createTitle')}
          </h3>
          <CloseButton onClick={handleClose} />
        </div>

        <div className={styles.body}>
          <FormField label={t('creatorWorkshop.shared.name')} required>
            <TextInput value={name} onChange={setName} placeholder={t('creatorWorkshop.lumiaEditor.characterNamePlaceholder')} autoFocus />
          </FormField>

          <FormField label={t('creatorWorkshop.lumiaEditor.avatarUrl')}>
            <ImageInput value={avatarUrl} onChange={setAvatarUrl} placeholder={t('creatorWorkshop.lumiaEditor.avatarPlaceholder')} />
          </FormField>

          <div className={styles.row}>
            <div className={styles.rowHalf}>
              <FormField label={t('creatorWorkshop.shared.author')}>
                <TextInput value={authorName} onChange={setAuthorName} placeholder={t('creatorWorkshop.lumiaEditor.authorPlaceholder')} />
              </FormField>
            </div>
            <div className={styles.rowHalf}>
              <FormField label={t('creatorWorkshop.lumiaEditor.genderIdentity')}>
                <Select value={genderIdentity} onChange={setGenderIdentity} options={genderOptions} />
              </FormField>
            </div>
          </div>

          <FormField label={t('creatorWorkshop.lumiaEditor.definition')} hint={t('creatorWorkshop.lumiaEditor.definitionHint')}>
            <TextArea value={definition} onChange={setDefinition} placeholder={t('creatorWorkshop.lumiaEditor.definitionPlaceholder')} rows={4} />
          </FormField>

          <FormField label={t('creatorWorkshop.lumiaEditor.personality')} hint={t('creatorWorkshop.lumiaEditor.personalityHint')}>
            <TextArea value={personality} onChange={setPersonality} placeholder={t('creatorWorkshop.lumiaEditor.personalityPlaceholder')} rows={3} />
          </FormField>

          <FormField label={t('creatorWorkshop.lumiaEditor.behavior')} hint={t('creatorWorkshop.lumiaEditor.behaviorHint')}>
            <TextArea value={behavior} onChange={setBehavior} placeholder={t('creatorWorkshop.lumiaEditor.behaviorPlaceholder')} rows={3} />
          </FormField>
        </div>

        <div className={styles.footer}>
          <Button variant="ghost" onClick={handleClose}>{t('creatorWorkshop.shared.cancel')}</Button>
          <Button variant="primary" onClick={handleSave} disabled={!name.trim() || saving}>
            {saving
              ? t('creatorWorkshop.shared.saving')
              : editingItem
                ? t('creatorWorkshop.shared.saveChanges')
                : t('creatorWorkshop.shared.create')}
          </Button>
        </div>
      </ModalShell>

      {showDiscard && (
        <ConfirmationModal
          isOpen
          title={t('creatorWorkshop.shared.discardTitle')}
          message={t('creatorWorkshop.shared.discardMessage')}
          variant="warning"
          confirmText={t('creatorWorkshop.shared.discard')}
          cancelText={t('creatorWorkshop.shared.keepEditing')}
          onConfirm={() => {
            setShowDiscard(false)
            closeModal()
          }}
          onCancel={() => setShowDiscard(false)}
          zIndex={10003}
        />
      )}
    </>
  )
}
