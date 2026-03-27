import { useState, useEffect, useCallback, useRef } from 'react'
import { X } from 'lucide-react'
import { Loader2 } from 'lucide-react'
import { useStore } from '@/store'
import { charactersApi } from '@/api/characters'
import { characterGalleryApi } from '@/api/character-gallery'
import { getCharacterAvatarLargeUrl } from '@/lib/avatarUrls'
import { imagesApi } from '@/api/images'
import LazyImage from '@/components/shared/LazyImage'
import ImageLightbox from '@/components/shared/ImageLightbox'
import AvatarSwitcherPopover from './AvatarSwitcherPopover'
import type { Character, CharacterGalleryItem } from '@/types/api'
import styles from './PortraitPanel.module.css'
import clsx from 'clsx'

interface PortraitPanelProps {
  side?: 'left' | 'right'
}

export default function PortraitPanel({ side = 'right' }: PortraitPanelProps) {
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeChatAvatarId = useStore((s) => s.activeChatAvatarId)
  const characters = useStore((s) => s.characters)
  const togglePortraitPanel = useStore((s) => s.togglePortraitPanel)
  const storedCharacter = activeCharacterId
    ? characters.find((entry) => entry.id === activeCharacterId) ?? null
    : null
  const [character, setCharacter] = useState<Character | null>(null)
  const [gallery, setGallery] = useState<CharacterGalleryItem[]>([])
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  useEffect(() => {
    if (storedCharacter) setCharacter(storedCharacter)
  }, [storedCharacter])

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

  // Resolve lightbox URL — use original quality (no size tier) for full aspect ratio
  const getLightboxUrl = useCallback(() => {
    if (activeChatAvatarId) {
      // Active alternate override — check if it has an original (uncropped) image
      const alts = character?.extensions?.alternate_avatars as Array<{ image_id: string; original_image_id?: string }> | undefined
      const altEntry = alts?.find((a) => a.image_id === activeChatAvatarId)
      if (altEntry?.original_image_id) return imagesApi.url(altEntry.original_image_id)
      return imagesApi.url(activeChatAvatarId)
    }
    // Primary avatar — the character card image is already stored at full size
    if (character?.image_id) return imagesApi.url(character.image_id)
    return null
  }, [character, activeChatAvatarId])

  // ── Cross-fading avatar ──
  const avatarUrl = activeChatAvatarId
    ? imagesApi.largeUrl(activeChatAvatarId)
    : (getCharacterAvatarLargeUrl(character) ?? '')

  const [displayedSrc, setDisplayedSrc] = useState(avatarUrl)
  const [prevSrc, setPrevSrc] = useState<string | null>(null)
  const [frameHeight, setFrameHeight] = useState<number | undefined>(undefined)
  const [imgLoading, setImgLoading] = useState(true)
  const newImgRef = useRef<HTMLImageElement>(null)

  // When avatarUrl changes (avatar switch), start cross-fade
  useEffect(() => {
    if (avatarUrl === displayedSrc) return
    setPrevSrc(displayedSrc)
    setDisplayedSrc(avatarUrl)
    setImgLoading(true)
  }, [avatarUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleNewImageLoad = useCallback(() => {
    // Measure the image's natural aspect ratio and compute frame height
    const img = newImgRef.current
    if (img && img.naturalWidth > 0) {
      const frameWidth = 186 // matches CSS .frame width
      const ratio = img.naturalHeight / img.naturalWidth
      setFrameHeight(Math.round(frameWidth * ratio))
    }
    setImgLoading(false)
    // Clear previous image after transition completes
    const timer = setTimeout(() => setPrevSrc(null), 350)
    return () => clearTimeout(timer)
  }, [])

  if (!activeCharacterId) return null

  const charName = character?.name || ''

  return (
    <div
      className={clsx(styles.panelOuter, side === 'left' ? styles.panelOuterLeft : styles.panelOuterRight)}
    >
      <div className={styles.panel}>
        <button
          onClick={togglePortraitPanel}
          type="button"
          className={styles.closeBtn}
          aria-label="Close portrait panel"
        >
          <X size={14} />
        </button>

        <AvatarSwitcherPopover chatId={activeChatId || ''}>
          <div
            className={styles.frame}
            style={frameHeight ? { height: frameHeight } : undefined}
            onClick={() => setLightboxSrc(getLightboxUrl())}
          >
            {/* Previous image — fades out */}
            {prevSrc && (
              <img
                src={prevSrc}
                alt=""
                className={clsx(styles.avatarImg, styles.avatarImgOut)}
              />
            )}
            {/* Current image — fades in once loaded */}
            {displayedSrc ? (
              <img
                ref={newImgRef}
                src={displayedSrc}
                alt={charName}
                className={clsx(styles.avatarImg, imgLoading ? styles.avatarImgLoading : styles.avatarImgIn)}
                onLoad={handleNewImageLoad}
                onError={() => setImgLoading(false)}
              />
            ) : (
              <div className={styles.placeholder}>
                {(charName || '?')[0].toUpperCase()}
              </div>
            )}
            {/* Loading spinner during image fetch */}
            {imgLoading && displayedSrc && (
              <div className={styles.avatarSpinner}>
                <Loader2 size={20} strokeWidth={1.5} />
              </div>
            )}
          </div>
        </AvatarSwitcherPopover>

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
                    src={characterGalleryApi.smallUrl(item.image_id)}
                    alt={item.caption || ''}
                    className={styles.mosaicImg}
                    fallback={<div className={styles.mosaicPlaceholder} />}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      <ImageLightbox src={lightboxSrc} onClose={closeLightbox} />
    </div>
  )
}
