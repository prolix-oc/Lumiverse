import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { characterGalleryApi } from '@/api/character-gallery'
import type { CharacterGalleryItem } from '@/types/api'
import { isImageDeleted, isGalleryItemRemoved, onImageDeleted, onGalleryItemRemoved } from '@/lib/deletion-events'
import { ModalShell } from '@/components/shared/ModalShell'
import { Spinner } from '@/components/shared/Spinner'
import styles from './CharacterGalleryPicker.module.css'

interface Props {
  characterId: string
  onSelect: (item: CharacterGalleryItem) => void
  onClose: () => void
}

/** Select an existing image without changing its gallery membership. */
export default function CharacterGalleryPicker({ characterId, onSelect, onClose }: Props) {
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')
  const titleId = useId()
  const [items, setItems] = useState<CharacterGalleryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setItems([])
    setLoading(true)
    setFailed(false)
    characterGalleryApi.list(characterId).then((result) => {
      if (!cancelled) setItems(result.filter((item) => !isImageDeleted(item.image_id) && !isGalleryItemRemoved(characterId, item.id)))
    }).catch(() => {
      if (!cancelled) setFailed(true)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [characterId, attempt])

  useEffect(() => onImageDeleted((id) => {
    setItems((current) => current.filter((item) => item.image_id !== id))
  }), [])

  useEffect(() => onGalleryItemRemoved((removed) => {
    if (removed.characterId === characterId) setItems((current) => current.filter((item) => item.id !== removed.id))
  }), [characterId])

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={560} mobilePresentation="dialog" data-component="CharacterGalleryPicker">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={styles.content}>
        <div className={styles.header}>
          <h3 id={titleId}>{t('characterEditor.expressionEditor.selectFromGallery')}</h3>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label={tc('actions.close')}>
            <X size={18} />
          </button>
        </div>
        <div className={styles.body}>
          {loading ? (
            <div className={styles.status} role="status"><Spinner /> {tc('actions.loading')}</div>
          ) : failed ? (
            <div className={styles.status} role="alert">
              <span>{t('characterBrowser.alternateAvatars.galleryLoadFailed')}</span>
              <button type="button" className={styles.retryBtn} onClick={() => setAttempt((value) => value + 1)}>{tc('actions.retry')}</button>
            </div>
          ) : items.length === 0 ? (
            <div className={styles.status}>{t('characterEditor.expressionEditor.noGalleryImages')}</div>
          ) : (
            <div className={styles.grid}>
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.item}
                  onClick={() => {
                    if (!isImageDeleted(item.image_id) && !isGalleryItemRemoved(characterId, item.id)) onSelect(item)
                  }}
                  aria-label={item.caption || item.reference}
                  title={item.caption || item.reference}
                >
                  <img src={characterGalleryApi.smallUrl(item.image_id)} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className={styles.footer}>
          <button type="button" className={styles.retryBtn} onClick={onClose}>{tc('actions.cancel')}</button>
        </div>
      </div>
    </ModalShell>
  )
}
