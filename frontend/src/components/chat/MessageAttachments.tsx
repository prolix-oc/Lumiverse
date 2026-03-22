import { useState, useCallback } from 'react'
import type { MessageAttachment } from '@/types/api'
import { imagesApi } from '@/api/images'
import ImageLightbox from './ImageLightbox'
import styles from './MessageAttachments.module.css'
import clsx from 'clsx'

interface MessageAttachmentsProps {
  attachments: MessageAttachment[]
  isUser?: boolean
}

export default function MessageAttachments({ attachments, isUser }: MessageAttachmentsProps) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  const closeLightbox = useCallback(() => setLightboxSrc(null), [])

  const images = attachments.filter((a) => a.type === 'image')
  const audios = attachments.filter((a) => a.type === 'audio')

  if (images.length === 0 && audios.length === 0) return null

  return (
    <>
      <div className={clsx(styles.attachments, isUser && styles.attachmentsUser)}>
        {images.map((att) =>
          isUser ? (
            <button
              key={att.image_id}
              type="button"
              className={styles.imageThumbUser}
              onClick={() => setLightboxSrc(imagesApi.url(att.image_id))}
              title={att.original_filename}
            >
              <img
                src={imagesApi.url(att.image_id)}
                alt={att.original_filename}
                loading="lazy"
              />
            </button>
          ) : (
            <span key={att.image_id} className={styles.inlineImageWrap}>
              <img
                src={imagesApi.url(att.image_id)}
                alt={att.original_filename}
                className={styles.inlineImage}
                loading="lazy"
                onClick={() => setLightboxSrc(imagesApi.url(att.image_id))}
              />
            </span>
          )
        )}
        {audios.map((att) => (
          <div key={att.image_id} className={styles.audioWrap}>
            <audio controls preload="metadata" className={styles.audioPlayer}>
              <source src={imagesApi.url(att.image_id)} type={att.mime_type} />
            </audio>
            <span className={styles.audioName}>{att.original_filename}</span>
          </div>
        ))}
      </div>

      <ImageLightbox src={lightboxSrc} onClose={closeLightbox} />
    </>
  )
}
