import { useState, useCallback, useMemo, type CSSProperties } from 'react'
import { Trash2 } from 'lucide-react'
import type { MessageAttachment } from '@/types/api'
import { imagesApi } from '@/api/images'
import { messagesApi } from '@/api/chats'
import { useStore } from '@/store'
import { useLongPress } from '@/hooks/useLongPress'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import ImageLightbox from '@/components/shared/ImageLightbox'
import LazyImage from '@/components/shared/LazyImage'
import styles from './MessageAttachments.module.css'
import clsx from 'clsx'

interface MessageAttachmentsProps {
  attachments: MessageAttachment[]
  isUser?: boolean
  /** Chat + message ids enable per-image actions (Remove image). Omit to render in read-only mode. */
  chatId?: string
  messageId?: string
}

function getImageFrameStyle(att: MessageAttachment): CSSProperties | undefined {
  if (!att.width || !att.height) return undefined
  const scale = Math.min(1, 240 / att.width, 240 / att.height)

  return {
    aspectRatio: `${att.width} / ${att.height}`,
    width: Math.max(1, Math.round(att.width * scale)),
    maxWidth: '100%',
  }
}

export default function MessageAttachments({ attachments, isUser, chatId, messageId }: MessageAttachmentsProps) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [contextMenuPos, setContextMenuPos] = useState<ContextMenuPos | null>(null)
  const [targetImageId, setTargetImageId] = useState<string | null>(null)
  const messageContextMenuEnabled = useStore((s) => s.messageContextMenuEnabled ?? true)
  const addToast = useStore((s) => s.addToast)

  const canActOnImage = messageContextMenuEnabled && !!chatId && !!messageId
  const closeLightbox = useCallback(() => setLightboxSrc(null), [])
  const closeContextMenu = useCallback(() => {
    setContextMenuPos(null)
    setTargetImageId(null)
  }, [])

  const openImageMenu = useCallback((imageId: string, pos: ContextMenuPos) => {
    setTargetImageId(imageId)
    setContextMenuPos(pos)
  }, [])

  const removeAttachment = useCallback(async () => {
    if (!chatId || !messageId || !targetImageId) return
    closeContextMenu()
    try {
      // Drive the same-tab UI off the HTTP response so the bubble refreshes the
      // instant the request resolves. The backend also broadcasts MESSAGE_EDITED
      // over WS, which keeps other tabs / clients in sync as a defensive
      // parallel update.
      const updated = await messagesApi.removeAttachment(chatId, messageId, targetImageId)
      if (updated) {
        useStore.getState().updateMessage(messageId, updated)
      }
    } catch (err: any) {
      addToast({ type: 'error', title: 'Could not remove image', message: err?.body?.error || err?.message || 'Unknown error' })
    }
  }, [addToast, chatId, closeContextMenu, messageId, targetImageId])

  const longPress = useLongPress({
    onLongPress: (pos) => {
      // Long-press fires for the most-recently armed image (set in onTouchStart below).
      if (!canActOnImage) return
      const armed = longPressTargetRef.current
      if (!armed) return
      openImageMenu(armed, pos)
    },
  })

  // Track which image started the touch so the long-press callback knows the target.
  // (useLongPress doesn't pass the event target through.)
  const longPressTargetRef = useMemo(() => ({ current: null as string | null }), [])

  const onImageTouchStart = useCallback((imageId: string) => (e: React.TouchEvent) => {
    longPressTargetRef.current = imageId
    longPress.onTouchStart(e)
  }, [longPress, longPressTargetRef])

  const onImageContextMenu = useCallback((imageId: string) => (e: React.MouseEvent) => {
    if (!canActOnImage) return
    e.preventDefault()
    e.stopPropagation()
    openImageMenu(imageId, { x: e.clientX, y: e.clientY })
  }, [canActOnImage, openImageMenu])

  const contextMenuItems: ContextMenuEntry[] = useMemo(() => [
    {
      key: 'remove-image',
      label: 'Remove image',
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => { void removeAttachment() },
    },
  ], [removeAttachment])

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
              style={getImageFrameStyle(att)}
              onClick={() => setLightboxSrc(imagesApi.url(att.image_id))}
              onContextMenu={onImageContextMenu(att.image_id)}
              onTouchStart={canActOnImage ? onImageTouchStart(att.image_id) : undefined}
              onTouchMove={canActOnImage ? longPress.onTouchMove : undefined}
              onTouchEnd={canActOnImage ? longPress.onTouchEnd : undefined}
              title={att.original_filename}
            >
              <LazyImage
                src={imagesApi.url(att.image_id)}
                alt={att.original_filename}
                style={{ objectFit: 'contain' }}
                spinnerSize={18}
              />
            </button>
          ) : (
            <button
              key={att.image_id}
              type="button"
              className={styles.inlineImageBtn}
              style={getImageFrameStyle(att)}
              onClick={() => setLightboxSrc(imagesApi.url(att.image_id))}
              onContextMenu={onImageContextMenu(att.image_id)}
              onTouchStart={canActOnImage ? onImageTouchStart(att.image_id) : undefined}
              onTouchMove={canActOnImage ? longPress.onTouchMove : undefined}
              onTouchEnd={canActOnImage ? longPress.onTouchEnd : undefined}
            >
              <LazyImage
                src={imagesApi.url(att.image_id)}
                alt={att.original_filename}
                className={styles.inlineImage}
                style={att.width && att.height
                  ? { objectFit: 'contain' }
                  : { objectFit: 'contain', width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '240px' }
                }
                containerClassName={styles.inlineImageWrap}
                spinnerSize={20}
              />
            </button>
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
      <ContextMenu position={contextMenuPos} items={contextMenuItems} onClose={closeContextMenu} />
    </>
  )
}
