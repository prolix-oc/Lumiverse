import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { Copy, Download, Trash2 } from 'lucide-react'
import { Spinner } from '@/components/shared/Spinner'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { useLongPress } from '@/hooks/useLongPress'
import { copyImageToClipboard } from '@/lib/clipboard'
import { downloadImageFromUrl } from '@/lib/downloads'
import {
  constrainImageLightboxZoom,
  pinchImageLightboxZoom,
  INITIAL_IMAGE_LIGHTBOX_ZOOM,
  type ImageLightboxPoint,
  type ImageLightboxZoom,
} from '@/lib/imageLightboxZoom'
import { toast } from '@/lib/toast'
import { onImageDeleted } from '@/lib/deletion-events'
import styles from './ImageLightbox.module.css'

interface ImageLightboxProps {
  src: string | null
  fallbackSrc?: string | null
  onClose: () => void
  /**
   * When provided, a "Delete" entry is added to the right-click / long-press
   * menu. The callback performs the actual deletion; the lightbox handles the
   * confirmation prompt and closes itself once the promise resolves. Throw to
   * surface a failure toast.
   */
  onDelete?: () => void | Promise<void>
  /** Overrides the delete confirmation title (e.g. "Discard this image?"). */
  deleteTitle?: string
  /** Overrides the delete confirmation body copy. */
  deleteMessage?: string
  /** Filename for the Download action (extension is appended automatically if absent). */
  downloadFilename?: string
}

export default function ImageLightbox({
  src,
  fallbackSrc,
  onClose,
  onDelete,
  deleteTitle,
  deleteMessage,
  downloadFilename,
}: ImageLightboxProps) {
  const { t } = useTranslation('shared', { keyPrefix: 'imageLightbox' })
  const [currentSrc, setCurrentSrc] = useState(src)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [menuPos, setMenuPos] = useState<ContextMenuPos | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [imageZoom, setImageZoom] = useState(INITIAL_IMAGE_LIGHTBOX_ZOOM)
  const [isMousePanning, setIsMousePanning] = useState(false)
  const zoomRef = useRef(INITIAL_IMAGE_LIGHTBOX_ZOOM)
  const imageRef = useRef<HTMLImageElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const pinchStartRef = useRef<{ distance: number; point: ImageLightboxPoint; zoom: ImageLightboxZoom } | null>(null)
  const panPointRef = useRef<ImageLightboxPoint | null>(null)
  const mousePanRef = useRef<{ pointerId: number; point: ImageLightboxPoint } | null>(null)
  const pointerPointRef = useRef<ImageLightboxPoint | null>(null)
  const gestureStartRef = useRef<{ point: ImageLightboxPoint; zoom: ImageLightboxZoom } | null>(null)

  // Mirror the overlay states into refs so the document-level Escape and
  // backdrop handlers can tell when an inner layer (menu / confirm dialog)
  // owns the interaction and should swallow it instead of closing the lightbox.
  const menuOpenRef = useRef(false)
  const confirmingRef = useRef(false)
  menuOpenRef.current = menuPos !== null
  confirmingRef.current = confirmingDelete

  useEffect(() => {
    setCurrentSrc(src)
    if (src) {
      setIsLoading(true)
      setHasError(false)
    } else {
      setMenuPos(null)
      setConfirmingDelete(false)
      setDeleting(false)
    }
  }, [src, fallbackSrc])

  useEffect(() => onImageDeleted((id) => {
    const imageId = currentSrc?.match(/\/images\/([^/?#]+)/)?.[1]
    if (imageId === encodeURIComponent(id) || imageId === id) onClose()
  }), [currentSrc, onClose])

  useEffect(() => {
    const pan = mousePanRef.current
    if (pan && imageRef.current?.hasPointerCapture(pan.pointerId)) {
      imageRef.current.releasePointerCapture(pan.pointerId)
    }
    zoomRef.current = INITIAL_IMAGE_LIGHTBOX_ZOOM
    setImageZoom(INITIAL_IMAGE_LIGHTBOX_ZOOM)
    pinchStartRef.current = null
    panPointRef.current = null
    mousePanRef.current = null
    pointerPointRef.current = null
    gestureStartRef.current = null
    setIsMousePanning(false)
  }, [currentSrc])

  useEffect(() => {
    if (!src) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Let an open menu / confirm dialog handle Escape themselves.
      if (menuOpenRef.current || confirmingRef.current) return
      onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [src, onClose])

  const mouseDownTargetRef = useRef<EventTarget | null>(null)
  const menuOpenAtDownRef = useRef(false)

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      // A click that dismissed an open context menu shouldn't also close the
      // lightbox — swallow this one and let the next click through.
      if (menuOpenAtDownRef.current) {
        menuOpenAtDownRef.current = false
        return
      }
      if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) onClose()
    },
    [onClose]
  )

  const handleLoad = useCallback(() => setIsLoading(false), [])
  const handleError = useCallback(() => {
    if (fallbackSrc && currentSrc !== fallbackSrc) {
      setCurrentSrc(fallbackSrc)
      setIsLoading(true)
      setHasError(false)
      return
    }
    setIsLoading(false)
    setHasError(true)
  }, [currentSrc, fallbackSrc])

  const longPress = useLongPress({ onLongPress: (pos) => setMenuPos(pos) })

  const updateImageZoom = useCallback((zoom: ImageLightboxZoom) => {
    zoomRef.current = zoom
    setImageZoom(zoom)
  }, [])

  const getZoomGeometry = useCallback(() => {
    const image = imageRef.current
    const backdrop = backdropRef.current
    if (!image || !backdrop) return null
    const rect = backdrop.getBoundingClientRect()
    const uiScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale')) || 1
    return {
      uiScale,
      bounds: {
        imageWidth: image.offsetWidth,
        imageHeight: image.offsetHeight,
        viewportWidth: backdrop.clientWidth,
        viewportHeight: backdrop.clientHeight,
      },
      point: (clientX: number, clientY: number) => ({
        x: (clientX - rect.left - rect.width / 2) / uiScale,
        y: (clientY - rect.top - rect.height / 2) / uiScale,
      }),
    }
  }, [])

  useEffect(() => {
    const image = imageRef.current
    if (!src || !image || hasError) return

    const handleWheel = (event: WheelEvent) => {
      if (!event.deltaY) return
      const geometry = getZoomGeometry()
      if (!geometry) return
      event.preventDefault()
      if (gestureStartRef.current) return
      const sensitivity = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 0.04
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 0.2
          : event.ctrlKey ? 0.01 : 0.002
      const point = geometry.point(event.clientX, event.clientY)
      updateImageZoom(pinchImageLightboxZoom(
        zoomRef.current, 1, Math.exp(-event.deltaY * sensitivity), point, point, geometry.bounds,
      ))
    }

    const handleGestureStart = (event: Event) => {
      if (pinchStartRef.current) return
      const geometry = getZoomGeometry()
      if (!geometry) return
      const rect = image.getBoundingClientRect()
      const pointer = pointerPointRef.current
      gestureStartRef.current = {
        point: geometry.point(pointer?.x ?? rect.left + rect.width / 2, pointer?.y ?? rect.top + rect.height / 2),
        zoom: zoomRef.current,
      }
      event.preventDefault()
    }

    const handleGestureChange = (event: Event) => {
      const start = gestureStartRef.current
      const scale = (event as Event & { scale?: number }).scale
      const geometry = getZoomGeometry()
      if (!start || pinchStartRef.current || !scale || !Number.isFinite(scale) || !geometry) return
      event.preventDefault()
      updateImageZoom(pinchImageLightboxZoom(start.zoom, 1, scale, start.point, start.point, geometry.bounds))
    }

    const handleGestureEnd = () => { gestureStartRef.current = null }

    image.addEventListener('wheel', handleWheel, { passive: false })
    image.addEventListener('gesturestart', handleGestureStart, { passive: false })
    image.addEventListener('gesturechange', handleGestureChange, { passive: false })
    image.addEventListener('gestureend', handleGestureEnd)
    return () => {
      image.removeEventListener('wheel', handleWheel)
      image.removeEventListener('gesturestart', handleGestureStart)
      image.removeEventListener('gesturechange', handleGestureChange)
      image.removeEventListener('gestureend', handleGestureEnd)
    }
  }, [src, currentSrc, hasError, getZoomGeometry, updateImageZoom])

  const stopMousePan = (event: React.PointerEvent<HTMLImageElement>) => {
    if (mousePanRef.current?.pointerId !== event.pointerId) return
    mousePanRef.current = null
    setIsMousePanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleImagePointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || zoomRef.current.scale <= 1) return
    mousePanRef.current = { pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY } }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsMousePanning(true)
  }

  const handleImagePointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    if (event.pointerType === 'mouse') pointerPointRef.current = { x: event.clientX, y: event.clientY }
    const pan = mousePanRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    if (!(event.buttons & 1) || zoomRef.current.scale <= 1) {
      stopMousePan(event)
      return
    }
    const geometry = getZoomGeometry()
    if (!geometry) return
    mousePanRef.current = { pointerId: pan.pointerId, point: { x: event.clientX, y: event.clientY } }
    updateImageZoom(constrainImageLightboxZoom({
      ...zoomRef.current,
      x: zoomRef.current.x + (event.clientX - pan.point.x) / geometry.uiScale,
      y: zoomRef.current.y + (event.clientY - pan.point.y) / geometry.uiScale,
    }, geometry.bounds))
  }

  const startPinch = (touches: React.TouchList) => {
    const geometry = getZoomGeometry()
    if (!geometry) return
    gestureStartRef.current = null
    pinchStartRef.current = {
      distance: Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY),
      point: geometry.point(
        (touches[0].clientX + touches[1].clientX) / 2,
        (touches[0].clientY + touches[1].clientY) / 2,
      ),
      zoom: zoomRef.current,
    }
    panPointRef.current = null
  }

  const handleImageTouchStart = (event: React.TouchEvent<HTMLImageElement>) => {
    if (event.touches.length > 1) {
      longPress.onTouchCancel()
      startPinch(event.touches)
      return
    }
    longPress.onTouchStart(event)
    if (zoomRef.current.scale > 1) {
      panPointRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }
    }
  }

  const handleImageTouchMove = (event: React.TouchEvent<HTMLImageElement>) => {
    if (event.touches.length > 1) {
      longPress.onTouchCancel()
      if (!pinchStartRef.current) startPinch(event.touches)
      const start = pinchStartRef.current
      const geometry = getZoomGeometry()
      if (!start || !geometry) return
      const distance = Math.hypot(
        event.touches[0].clientX - event.touches[1].clientX,
        event.touches[0].clientY - event.touches[1].clientY,
      )
      const point = geometry.point(
        (event.touches[0].clientX + event.touches[1].clientX) / 2,
        (event.touches[0].clientY + event.touches[1].clientY) / 2,
      )
      updateImageZoom(pinchImageLightboxZoom(start.zoom, start.distance, distance, start.point, point, geometry.bounds))
      return
    }

    longPress.onTouchMove(event)
    if (event.touches.length !== 1 || zoomRef.current.scale <= 1) return
    const touch = event.touches[0]
    const previous = panPointRef.current
    panPointRef.current = { x: touch.clientX, y: touch.clientY }
    const geometry = getZoomGeometry()
    if (!previous || !geometry) return
    updateImageZoom(constrainImageLightboxZoom({
      ...zoomRef.current,
      x: zoomRef.current.x + (touch.clientX - previous.x) / geometry.uiScale,
      y: zoomRef.current.y + (touch.clientY - previous.y) / geometry.uiScale,
    }, geometry.bounds))
  }

  const handleImageTouchEnd = (event: React.TouchEvent<HTMLImageElement>) => {
    longPress.onTouchEnd(event)
    if (event.touches.length > 1) {
      startPinch(event.touches)
      return
    }
    pinchStartRef.current = null
    panPointRef.current = event.touches.length === 1
      ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
      : null
  }

  const handleImageTouchCancel = () => {
    longPress.onTouchCancel()
    pinchStartRef.current = null
    panPointRef.current = null
  }

  const handleCopy = useCallback(async () => {
    setMenuPos(null)
    if (!currentSrc) return
    try {
      await copyImageToClipboard(currentSrc)
      toast.success(t('copied'))
    } catch {
      toast.error(t('copyFailed'))
    }
  }, [currentSrc, t])

  const handleDownload = useCallback(async () => {
    setMenuPos(null)
    if (!currentSrc) return
    try {
      await downloadImageFromUrl(currentSrc, downloadFilename)
    } catch {
      toast.error(t('downloadFailed'))
    }
  }, [currentSrc, downloadFilename, t])

  const handleConfirmDelete = useCallback(async () => {
    if (!onDelete) return
    setDeleting(true)
    try {
      await onDelete()
      setConfirmingDelete(false)
      onClose()
    } catch {
      toast.error(t('deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }, [onDelete, onClose, t])

  const menuItems = useMemo<ContextMenuEntry[]>(() => {
    const items: ContextMenuEntry[] = [
      { key: 'copy', label: t('copyImage'), icon: <Copy size={14} />, onClick: () => { void handleCopy() } },
      { key: 'download', label: t('downloadImage'), icon: <Download size={14} />, onClick: () => { void handleDownload() } },
    ]
    if (onDelete) {
      items.push({ key: 'delete-divider', type: 'divider' })
      items.push({
        key: 'delete',
        label: t('deleteImage'),
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => { setMenuPos(null); setConfirmingDelete(true) },
      })
    }
    return items
  }, [t, onDelete, handleCopy, handleDownload])

  return createPortal(
    <>
      <AnimatePresence>
        {src && (
          <motion.div
            ref={backdropRef}
            data-viewport-zoom-exempt=""
            className={styles.backdrop}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onMouseDown={(e) => {
              mouseDownTargetRef.current = e.target
              menuOpenAtDownRef.current = menuOpenRef.current
            }}
            onClick={handleBackdropClick}
          >
            {isLoading && (
              <div className={styles.spinner}>
                <Spinner size={32} />
              </div>
            )}
            {hasError ? (
              <div className={styles.error}>{t('loadFailed')}</div>
            ) : (
              <img
                ref={imageRef}
                src={currentSrc || ''}
                alt=""
                className={styles.image}
                style={{
                  opacity: isLoading ? 0 : 1,
                  transform: `translate3d(${imageZoom.x}px, ${imageZoom.y}px, 0) scale(${imageZoom.scale})`,
                  cursor: isMousePanning ? 'grabbing' : imageZoom.scale > 1 ? 'grab' : undefined,
                }}
                draggable={false}
                onLoad={handleLoad}
                onError={handleError}
                onContextMenu={longPress.onContextMenu}
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse') pointerPointRef.current = { x: event.clientX, y: event.clientY }
                }}
                onPointerLeave={() => { pointerPointRef.current = null }}
                onPointerDown={handleImagePointerDown}
                onPointerMove={handleImagePointerMove}
                onPointerUp={stopMousePan}
                onPointerCancel={stopMousePan}
                onLostPointerCapture={stopMousePan}
                onTouchStart={handleImageTouchStart}
                onTouchMove={handleImageTouchMove}
                onTouchEnd={handleImageTouchEnd}
                onTouchCancel={handleImageTouchCancel}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <ContextMenu position={menuPos} items={menuItems} onClose={() => setMenuPos(null)} />

      {onDelete && (
        <ConfirmationModal
          isOpen={confirmingDelete}
          onConfirm={() => { void handleConfirmDelete() }}
          onCancel={() => setConfirmingDelete(false)}
          title={deleteTitle ?? t('deleteTitle')}
          message={deleteMessage ?? t('deleteMessage')}
          variant="danger"
          confirmText={t('delete')}
          zIndex={11050}
          loading={deleting}
        />
      )}
    </>,
    document.body
  )
}
