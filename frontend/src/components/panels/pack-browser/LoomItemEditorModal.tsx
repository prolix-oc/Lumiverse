import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { Button } from '@/components/shared/FormComponents'
import { packsApi } from '@/api/packs'
import type { LoomItem, LoomItemCategory } from '@/types/api'
import styles from './PackBrowser.module.css'

interface Props {
  packId: string
  initialData?: LoomItem
  onSave: () => void
  onClose: () => void
}

const CATEGORY_VALUES: LoomItemCategory[] = ['narrative_style', 'loom_utility', 'retrofit']

const CATEGORY_LABEL_KEYS: Record<LoomItemCategory, string> = {
  narrative_style: 'packBrowser.loomItemEditor.categoryNarrativeStyle',
  loom_utility: 'packBrowser.loomItemEditor.categoryLoomUtility',
  retrofit: 'packBrowser.loomItemEditor.categoryRetrofit',
}

export default function LoomItemEditorModal({ packId, initialData, onSave, onClose }: Props) {
  const { t } = useTranslation('panels')
  const categories = useMemo(() => CATEGORY_VALUES.map((value) => ({
    value,
    label: t(CATEGORY_LABEL_KEYS[value]),
  })), [t])

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

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={480} maxHeight="90vh" zIndex={10001} className={styles.modal}>
      <div className={styles.modalHeader}>
        <h2 className={styles.modalTitle}>
          {isEditing ? t('creatorWorkshop.loomEditor.editTitle') : t('creatorWorkshop.loomEditor.createTitle')}
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
            placeholder={t('creatorWorkshop.loomEditor.itemNamePlaceholder')}
            autoFocus
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>{t('creatorWorkshop.loomEditor.category')}</label>
          <select
            className={styles.fieldSelect}
            value={category}
            onChange={(e) => setCategory(e.target.value as LoomItemCategory)}
          >
            {categories.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>{t('creatorWorkshop.shared.author')}</label>
          <input
            type="text"
            className={styles.fieldInput}
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            placeholder={t('creatorWorkshop.loomEditor.authorPlaceholder')}
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>{t('creatorWorkshop.loomEditor.content')}</label>
          <textarea
            className={styles.fieldTextarea}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t('packBrowser.loomItemEditor.contentPlaceholder')}
            rows={6}
          />
          <div className={styles.charCount}>{t('packBrowser.charCount', { count: content.length })}</div>
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
