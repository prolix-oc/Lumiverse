import { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Image as ImageIcon, ImagePlus, X } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import { characterGalleryApi } from '@/api/character-gallery'
import { charactersApi } from '@/api/characters'
import { imagesApi } from '@/api/images'
import type { Character, CharacterGalleryItem } from '@/types/api'
import styles from './GreetingPickerModal.module.css'
import clsx from 'clsx'

interface GreetingPickerModalProps {
  character: Character
  activeContent?: string
  onSelect: (greetingIndex: number) => void
  onCancel: () => void
}

function containsImageMarkup(content: string): boolean {
  return /<img\b/i.test(content) || /!\[[^\]]*]\([^)]*\)/.test(content)
}

export default function GreetingPickerModal({
  character,
  activeContent,
  onSelect,
  onCancel,
}: GreetingPickerModalProps) {
  const { t } = useTranslation('modals')

  const greetings = [
    { label: t('greetingPicker.defaultGreeting'), content: character.first_mes },
    ...(character.alternate_greetings || []).map((g, i) => ({
      label: t('greetingPicker.greetingNumber', { number: i + 2 }),
      content: g,
    })),
  ]

  const activeIndex = activeContent !== undefined
    ? greetings.findIndex((g) => g.content === activeContent)
    : -1

  const listRef = useRef<HTMLDivElement>(null)
  const activeCardRef = useRef<HTMLButtonElement>(null)

  const [galleryItems, setGalleryItems] = useState<CharacterGalleryItem[]>([])
  const [galleryOpenIndex, setGalleryOpenIndex] = useState<number | null>(null)
  const greetingBgs = (character.extensions?.greeting_backgrounds ?? {}) as Record<number, string>

  useEffect(() => {
    characterGalleryApi.list(character.id).then(setGalleryItems).catch(() => {})
  }, [character.id])

  const assignBackground = useCallback(async (greetingIndex: number, imageId: string | null) => {
    const updated = { ...greetingBgs }
    if (imageId) {
      updated[greetingIndex] = imageId
    } else {
      delete updated[greetingIndex]
    }
    try {
      await charactersApi.update(character.id, {
        extensions: { ...character.extensions, greeting_backgrounds: updated },
      })
      character.extensions = { ...character.extensions, greeting_backgrounds: updated }
    } catch {}
    setGalleryOpenIndex(null)
  }, [character, greetingBgs])

  useEffect(() => {
    if (activeIndex < 0) return
    const list = listRef.current
    const card = activeCardRef.current
    if (!list || !card) return
    const target = card.offsetTop - (list.clientHeight - card.clientHeight) / 2
    list.scrollTop = Math.max(0, target)
  }, [activeIndex])

  return (
    <ModalShell isOpen onClose={onCancel} maxWidth={620} maxHeight="80vh" className={styles.modal}>
      <CloseButton onClick={onCancel} variant="solid" position="absolute" className={styles.closeBtnPos} />

      <div className={styles.header}>
        <h3 className={styles.title}>{t('greetingPicker.title')}</h3>
        <span className={styles.count}>{t('greetingPicker.count', { count: greetings.length })}</span>
      </div>

      <div ref={listRef} className={styles.list}>
        {greetings.map((g, i) => {
          const isActive = i === activeIndex
          const hasImage = containsImageMarkup(g.content)
          return (
            <button
              key={i}
              ref={isActive ? activeCardRef : undefined}
              type="button"
              className={clsx(styles.card, isActive && styles.cardActive)}
              onClick={() => onSelect(i)}
              style={{ animationDelay: `${Math.min(i * 40, 200)}ms` }}
            >
              <div className={styles.cardHeader}>
                <span className={styles.cardLabel}>{g.label}</span>
                <span className={styles.badgeRow}>
                  {hasImage && (
                    <span className={styles.mediaBadge}>
                      <ImageIcon size={10} />
                      {t('greetingPicker.image')}
                    </span>
                  )}
                  {isActive && (
                    <span className={styles.activeBadge}>
                      <Check size={10} />
                      {t('greetingPicker.active')}
                    </span>
                  )}
                  <button
                    type="button"
                    className={styles.bgPickerBtn}
                    onClick={(e) => {
                      e.stopPropagation()
                      setGalleryOpenIndex(galleryOpenIndex === i ? null : i)
                    }}
                    title="Set background image for this greeting"
                  >
                    {greetingBgs[i] ? (
                      <img
                        src={imagesApi.url(greetingBgs[i]) + '?size=sm'}
                        alt=""
                        className={styles.bgPickerThumb}
                      />
                    ) : (
                      <ImagePlus size={12} />
                    )}
                  </button>
                </span>
              </div>
              {galleryOpenIndex === i && (
                <div className={styles.bgGalleryPicker} onClick={(e) => e.stopPropagation()}>
                  <div className={styles.bgGalleryGrid}>
                    {galleryItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={clsx(
                          styles.bgGalleryItem,
                          greetingBgs[i] === item.image_id && styles.bgGalleryItemActive,
                        )}
                        onClick={() => assignBackground(i, item.image_id)}
                      >
                        <img src={characterGalleryApi.smallUrl(item.image_id)} alt={item.caption || ''} />
                      </button>
                    ))}
                  </div>
                  {greetingBgs[i] && (
                    <button
                      type="button"
                      className={styles.bgGalleryClear}
                      onClick={() => assignBackground(i, null)}
                    >
                      <X size={10} />
                      Clear background
                    </button>
                  )}
                  {galleryItems.length === 0 && (
                    <span className={styles.bgGalleryEmpty}>No gallery images. Add images in the character editor.</span>
                  )}
                </div>
              )}
              <div className={styles.cardPreview}>{g.content}</div>
            </button>
          )
        })}
      </div>
    </ModalShell>
  )
}
