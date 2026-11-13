import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { Button } from '@/components/shared/FormComponents'
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
  const { t } = useTranslation('panels')
  const [name, setName] = useState(initialData?.name || '')
  const [authorName, setAuthorName] = useState(initialData?.author_name || '')
  const [avatarUrl, setAvatarUrl] = useState(initialData?.avatar_url || '')
  const [genderIdentity, setGenderIdentity] = useState<0 | 1 | 2 | 3>(initialData?.gender_identity ?? 3)
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

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={480} maxHeight="90vh" zIndex={10001} className={styles.modal}>
      <div className={styles.modalHeader}>
        <h2 className={styles.modalTitle}>
          {isEditing ? t('packBrowser.lumiaItemEditor.editTitle') : t('packBrowser.lumiaItemEditor.newTitle')}
        </h2>
        <Button size="icon" variant="ghost" onClick={onClose} icon={<X size={16} />} />
      </div>
      <div className={styles.modalBody}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>{t('creatorWorkshop.shared.name')} *</label>
          <input
            type="text"
            className={styles.fieldInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('creatorWorkshop.lumiaEditor.characterNamePlaceholder')}
            autoFocus
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>{t('creatorWorkshop.lumiaEditor.genderIdentity')}</label>
          <select
            className={styles.fieldSelect}
            value={genderIdentity}
            onChange={(e) => setGenderIdentity(Number(e.target.value) as 0 | 1 | 2 | 3)}
          >
            <option value={0}>{t('creatorWorkshop.shared.gender.feminine')}</option>
            <option value={1}>{t('creatorWorkshop.shared.gender.masculine')}</option>
            <option value={2}>{t('creatorWorkshop.shared.gender.neutral')}</option>
            <option value={3}>{t('creatorWorkshop.shared.gender.any')}</option>
          </select>
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>{t('creatorWorkshop.shared.author')}</label>
          <input
            type="text"
            className={styles.fieldInput}
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            placeholder={t('creatorWorkshop.lumiaEditor.authorPlaceholder')}
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>{t('creatorWorkshop.lumiaEditor.avatarUrl')}</label>
          <input
            type="text"
            className={styles.fieldInput}
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            placeholder={t('creatorWorkshop.lumiaEditor.avatarPlaceholder')}
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>{t('creatorWorkshop.lumiaEditor.definition')}</label>
          <textarea
            className={styles.fieldTextarea}
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
            placeholder={t('packBrowser.lumiaItemEditor.definitionPlaceholder')}
            rows={4}
          />
          <div className={styles.charCount}>{t('packBrowser.charCount', { count: definition.length })}</div>
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>{t('creatorWorkshop.lumiaEditor.personality')}</label>
          <textarea
            className={styles.fieldTextarea}
            value={personality}
            onChange={(e) => setPersonality(e.target.value)}
            placeholder={t('packBrowser.lumiaItemEditor.personalityPlaceholder')}
            rows={3}
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>{t('creatorWorkshop.lumiaEditor.behavior')}</label>
          <textarea
            className={styles.fieldTextarea}
            value={behavior}
            onChange={(e) => setBehavior(e.target.value)}
            placeholder={t('packBrowser.lumiaItemEditor.behaviorPlaceholder')}
            rows={3}
          />
        </div>
      </div>
      <div className={styles.modalFooter}>
        <Button variant="ghost" onClick={onClose}>{t('creatorWorkshop.shared.cancel')}</Button>
        <Button
          variant="primary"
          disabled={!name.trim() || saving}
          loading={saving}
          onClick={handleSave}
        >
          {saving
            ? t('creatorWorkshop.shared.saving')
            : isEditing
              ? t('creatorWorkshop.shared.saveChanges')
              : t('creatorWorkshop.shared.create')}
        </Button>
      </div>
    </ModalShell>
  )
}
