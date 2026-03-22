import { useState, useEffect, useCallback } from 'react'
import { motion } from 'motion/react'
import { X } from 'lucide-react'
import { useStore } from '@/store'
import { charactersApi } from '@/api/characters'
import { characterGalleryApi } from '@/api/character-gallery'
import LazyImage from '@/components/shared/LazyImage'
import ImageLightbox from './ImageLightbox'
import type { Character, CharacterGalleryItem } from '@/types/api'
import styles from './PortraitPanel.module.css'
import clsx from 'clsx'

interface PortraitPanelProps {
  side?: 'left' | 'right'
}

export default function PortraitPanel({ side = 'right' }: PortraitPanelProps) {
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const togglePortraitPanel = useStore((s) => s.togglePortraitPanel)
  const [character, setCharacter] = useState<Character | null>(null)
  const [gallery, setGallery] = useState<CharacterGalleryItem[]>([])
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  useEffect(() => {
    if (!activeCharacterId) return
    charactersApi
      .get(activeCharacterId)
      .then(setCharacter)
      .catch(() => setCharacter(null))
    characterGalleryApi
      .list(activeCharacterId)
      .then(setGallery)
      .catch(() => setGallery([]))
  }, [activeCharacterId])

  const closeLightbox = useCallback(() => setLightboxSrc(null), [])

  if (!activeCharacterId) return null

  const avatarUrl = charactersApi.avatarUrl(activeCharacterId)
  const charName = character?.name || ''

  return (
    <motion.div
      className={clsx(styles.panelOuter, side === 'left' ? styles.panelOuterLeft : styles.panelOuterRight)}
      initial={{ width: 0 }}
      animate={{ width: 220 }}
      exit={{ width: 0 }}
      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
    >
      <motion.div
        className={styles.panel}
        initial={{ opacity: 0, x: side === 'left' ? -12 : 12 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: side === 'left' ? -12 : 12 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <button
          onClick={togglePortraitPanel}
          type="button"
          className={styles.closeBtn}
          aria-label="Close portrait panel"
        >
          <X size={14} />
        </button>

        <div className={styles.frame}>
          <LazyImage
            src={avatarUrl}
            alt={charName}
            containerClassName={styles.portrait}
            style={{ objectFit: 'contain', width: '100%', height: 'auto' }}
            fallback={
              <div className={styles.placeholder}>
                {(charName || '?')[0].toUpperCase()}
              </div>
            }
          />
        </div>

        <span className={styles.name}>{charName}</span>

        {gallery.length > 0 && (
          <div className={styles.mosaic}>
            {gallery.map((item, i) => {
              const ar = (item.width && item.height) ? item.width / item.height : 1
              // Assign span class based on aspect ratio and position for visual variety
              let span = styles.mosaicCell
              if (ar >= 1.4) {
                span = clsx(styles.mosaicCell, styles.mosaicWide)
              } else if (ar <= 0.7) {
                span = clsx(styles.mosaicCell, styles.mosaicTall)
              } else if (i % 5 === 0) {
                span = clsx(styles.mosaicCell, styles.mosaicLarge)
              }

              return (
                <div
                  key={item.id}
                  className={span}
                  onClick={() => setLightboxSrc(characterGalleryApi.imageUrl(item.image_id))}
                >
                  <LazyImage
                    src={characterGalleryApi.thumbnailUrl(item.image_id)}
                    alt={item.caption || ''}
                    className={styles.mosaicImg}
                    fallback={<div className={styles.mosaicPlaceholder} />}
                  />
                </div>
              )
            })}
          </div>
        )}
      </motion.div>

      <ImageLightbox src={lightboxSrc} onClose={closeLightbox} />
    </motion.div>
  )
}
