import { useState, useCallback, useMemo, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
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

function getLocalImageUrl(att: MessageAttachment): string {
  return imagesApi.url(att.image_id)
}

function getRelayPreviewUrl(att: MessageAttachment): string | null {
  return typeof att.relay_preview_url === 'string' && att.relay_preview_url.startsWith('data:image/')
    ? att.relay_preview_url
    : null
}

export default function MessageAttachments({ attachments, isUser, chatId, messageId }: MessageAttachmentsProps) {
  const { t } = useTranslation('chat')
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [lightboxFallbackSrc, setLightboxFallbackSrc] = useState<string | null>(null)
  const [lightboxImageId, setLightboxImageId] = useState<string | null>(null)
  const [contextMenuPos, setContextMenuPos] = useState<ContextMenuPos | null>(null)
  const [targetImageId, setTargetImageId] = useState<string | null>(null)
  const messageContextMenuEnabled = useStore((s) => s.messageContextMenuEnabled ?? true)
  const addToast = useStore((s) => s.addToast)

  const canActOnImage = messageContextMenuEnabled && !!chatId && !!messageId
  const closeLightbox = useCallback(() => {
    setLightboxSrc(null)
    setLightboxFallbackSrc(null)
    setLightboxImageId(null)
  }, [])
  const openLightbox = useCallback((att: MessageAttachment) => {
    setLightboxImageId(att.image_id)
    setLightboxSrc(getLocalImageUrl(att))
    setLightboxFallbackSrc(getRelayPreviewUrl(att))
  }, [])
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
      addToast({ type: 'error', title: t('attachments.couldNotRemoveImage'), message: err?.body?.error || err?.message || 'Unknown error' })
    }
  }, [addToast, chatId, closeContextMenu, messageId, targetImageId])

  // Removes the image currently shown in the lightbox. Throws on failure so the
  // lightbox surfaces its own error toast (the thumbnail context-menu path uses
  // removeAttachment above, which toasts here instead).
  const deleteLightboxImage = useCallback(async () => {
    if (!chatId || !messageId || !lightboxImageId) return
    const updated = await messagesApi.removeAttachment(chatId, messageId, lightboxImageId)
    if (updated) useStore.getState().updateMessage(messageId, updated)
  }, [chatId, messageId, lightboxImageId])

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
      label: t('attachments.removeImage'),
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => { void removeAttachment() },
    },
  ], [removeAttachment, t])

  // Audio attachments are rendered by the separate MessageAudioSlot
  // component as a sibling of MessageAttachments — keeping it out of the
  // flex-wrap row here means the slot can collapse to 0 height (without
  // dragging this wrapper's padding along) when there's no audio.
  const images = attachments.filter((a) => a.type === 'image')

  if (images.length === 0) return null

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
              onClick={() => openLightbox(att)}
              onContextMenu={onImageContextMenu(att.image_id)}
              onTouchStart={canActOnImage ? onImageTouchStart(att.image_id) : undefined}
              onTouchMove={canActOnImage ? longPress.onTouchMove : undefined}
              onTouchEnd={canActOnImage ? longPress.onTouchEnd : undefined}
              title={att.original_filename}
            >
              <LazyImage
                src={getLocalImageUrl(att)}
                alt={att.original_filename}
                style={{ objectFit: 'contain' }}
                spinnerSize={18}
                fallback={getRelayPreviewUrl(att) ? (
                  <LazyImage
                    src={getRelayPreviewUrl(att)}
                    alt={att.original_filename}
                    style={{ objectFit: 'contain' }}
                    spinnerSize={18}
                  />
                ) : null}
              />
            </button>
          ) : (
            <button
              key={att.image_id}
              type="button"
              className={styles.inlineImageBtn}
              style={getImageFrameStyle(att)}
              onClick={() => openLightbox(att)}
              onContextMenu={onImageContextMenu(att.image_id)}
              onTouchStart={canActOnImage ? onImageTouchStart(att.image_id) : undefined}
              onTouchMove={canActOnImage ? longPress.onTouchMove : undefined}
              onTouchEnd={canActOnImage ? longPress.onTouchEnd : undefined}
            >
              <LazyImage
                src={getLocalImageUrl(att)}
                alt={att.original_filename}
                className={styles.inlineImage}
                style={att.width && att.height
                  ? { objectFit: 'contain' }
                  : { objectFit: 'contain', width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '240px' }
                }
                containerClassName={styles.inlineImageWrap}
                spinnerSize={20}
                fallback={getRelayPreviewUrl(att) ? (
                  <LazyImage
                    src={getRelayPreviewUrl(att)}
                    alt={att.original_filename}
                    className={styles.inlineImage}
                    style={att.width && att.height
                      ? { objectFit: 'contain' }
                      : { objectFit: 'contain', width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '240px' }
                    }
                    containerClassName={styles.inlineImageWrap}
                    spinnerSize={20}
                  />
                ) : null}
              />
            </button>
          )
        )}
      </div>

      <ImageLightbox
        src={lightboxSrc}
        fallbackSrc={lightboxFallbackSrc}
        onClose={closeLightbox}
        onDelete={canActOnImage ? deleteLightboxImage : undefined}
      />
      <ContextMenu position={contextMenuPos} items={contextMenuItems} onClose={closeContextMenu} />
    </>
  )
}
