import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import { FormField, TextInput, TextArea, Button } from '@/components/shared/FormComponents'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { LoomItem, LoomItemCategory, CreateLoomItemInput } from '@/types/api'
import clsx from 'clsx'
import styles from './LoomEditorModal.module.css'

const CATEGORY_VALUES: LoomItemCategory[] = ['narrative_style', 'loom_utility', 'retrofit']

export default function LoomEditorModal() {
  const { t } = useTranslation('panels')
  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)

  const packId = modalProps.packId as string
  const editingItem = modalProps.editingItem as LoomItem | undefined
  const onSaved = modalProps.onSaved as (() => void) | undefined

  const categories = useMemo(() => CATEGORY_VALUES.map((value) => ({
    value,
    label: t(`creatorWorkshop.shared.category.${value === 'narrative_style' ? 'style' : value === 'loom_utility' ? 'utility' : 'retrofit'}`),
  })), [t])

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

  return (
    <>
      <ModalShell isOpen onClose={handleClose} maxWidth={640} maxHeight="90vh" closeOnEscape={false} className={styles.modal}>
        <div className={styles.header}>
          <h3 className={styles.title}>
            {editingItem ? t('creatorWorkshop.loomEditor.editTitle') : t('creatorWorkshop.loomEditor.createTitle')}
          </h3>
          <CloseButton onClick={handleClose} />
        </div>

        <div className={styles.body}>
          <FormField label={t('creatorWorkshop.shared.name')} required>
            <TextInput value={name} onChange={setName} placeholder={t('creatorWorkshop.loomEditor.itemNamePlaceholder')} autoFocus />
          </FormField>

          <FormField label={t('creatorWorkshop.loomEditor.category')}>
            <div className={styles.categoryTabs}>
              {categories.map((cat) => (
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

          <FormField label={t('creatorWorkshop.loomEditor.content')} required hint={t(`creatorWorkshop.loomEditor.hint.${category}`)}>
            <TextArea
              value={content}
              onChange={setContent}
              placeholder={t(`creatorWorkshop.loomEditor.placeholder.${category}`)}
              rows={6}
            />
          </FormField>

          <FormField label={t('creatorWorkshop.shared.author')}>
            <TextInput value={authorName} onChange={setAuthorName} placeholder={t('creatorWorkshop.loomEditor.authorPlaceholder')} />
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
