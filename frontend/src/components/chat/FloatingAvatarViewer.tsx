import { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useStore } from '@/store'
import LazyImage from '@/components/shared/LazyImage'
import styles from './FloatingAvatarViewer.module.css'

const MIN_SIZE = 120
const INITIAL_CAP = 600
const PAD = 12
const DRAG_BAR_H = 28
const DRAG_THRESHOLD = 5

// Resize is bounded by the viewport so the drag handle always stays reachable
const getViewportMax = () => ({
  maxW: Math.max(MIN_SIZE, window.innerWidth - PAD * 2),
  maxH: Math.max(MIN_SIZE, window.innerHeight - DRAG_BAR_H - PAD * 2),
})

export default function FloatingAvatarViewer() {
  const floatingAvatar = useStore((s) => s.floatingAvatar)
  const updateFloatingAvatar = useStore((s) => s.updateFloatingAvatar)
  const closeFloatingAvatar = useStore((s) => s.closeFloatingAvatar)

  const [pos, setPos] = useState({ x: -1, y: -1 })
  const [size, setSize] = useState({ width: 280, height: 280 })

  const dragging = useRef(false)
  const isDragging = useRef(false)
  const offset = useRef({ x: 0, y: 0 })
  const dragStartPos = useRef({ x: 0, y: 0 })
  const resizing = useRef(false)
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 })
  const aspectRatio = useRef(1)

  // Sync size from store
  useEffect(() => {
    if (!floatingAvatar) return
    setSize({ width: floatingAvatar.width, height: floatingAvatar.height })
  }, [floatingAvatar?.width, floatingAvatar?.height])

  // Position on open — center of viewport or use stored position
  useEffect(() => {
    if (!floatingAvatar) return
    let x = floatingAvatar.x
    let y = floatingAvatar.y
    if (x < 0 || y < 0) {
      x = Math.round((window.innerWidth - floatingAvatar.width) / 2)
      y = Math.round((window.innerHeight - floatingAvatar.height - DRAG_BAR_H) / 2)
    }
    x = Math.max(PAD, Math.min(x, window.innerWidth - floatingAvatar.width - PAD))
    y = Math.max(PAD, Math.min(y, window.innerHeight - floatingAvatar.height - DRAG_BAR_H - PAD))
    setPos({ x, y })
  }, [floatingAvatar?.imageUrl]) // re-center when a new image opens

  // Detect image aspect ratio and adjust container size
  useEffect(() => {
    if (!floatingAvatar?.imageUrl) return
    const img = new Image()
    img.onload = () => {
      const ratio = img.naturalWidth / img.naturalHeight
      if (!isFinite(ratio) || ratio <= 0) return
      aspectRatio.current = ratio

      const BASE = 280
      let w: number, h: number
      if (ratio >= 1) {
        w = BASE
        h = Math.round(BASE / ratio)
      } else {
        h = BASE
        w = Math.round(BASE * ratio)
      }
      const { maxW, maxH } = getViewportMax()
      w = Math.max(MIN_SIZE, Math.min(Math.min(INITIAL_CAP, maxW), w))
      h = Math.max(MIN_SIZE, Math.min(Math.min(INITIAL_CAP, maxH), h))

      setSize({ width: w, height: h })

      const cx = Math.max(PAD, Math.min(
        Math.round((window.innerWidth - w) / 2),
        window.innerWidth - w - PAD
      ))
      const cy = Math.max(PAD, Math.min(
        Math.round((window.innerHeight - h - DRAG_BAR_H) / 2),
        window.innerHeight - h - DRAG_BAR_H - PAD
      ))
      setPos({ x: cx, y: cy })
      updateFloatingAvatar({ width: w, height: h, x: cx, y: cy })
    }
    img.src = floatingAvatar.imageUrl
  }, [floatingAvatar?.imageUrl, updateFloatingAvatar])

  // Re-clamp on window resize — shrink size if viewport no longer fits, then clamp position
  useEffect(() => {
    if (!floatingAvatar) return
    const onResize = () => {
      const { maxW, maxH } = getViewportMax()
      const ratio = aspectRatio.current
      let w = Math.min(size.width, maxW)
      let h = Math.min(size.height, maxH)
      if (ratio > 0 && isFinite(ratio)) {
        if (w / ratio > h) w = Math.round(h * ratio)
        else h = Math.round(w / ratio)
      }
      w = Math.max(MIN_SIZE, w)
      h = Math.max(MIN_SIZE, h)
      if (w !== size.width || h !== size.height) setSize({ width: w, height: h })
      setPos((prev) => ({
        x: Math.max(PAD, Math.min(prev.x, window.innerWidth - w - PAD)),
        y: Math.max(PAD, Math.min(prev.y, window.innerHeight - h - DRAG_BAR_H - PAD)),
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [floatingAvatar, size.width, size.height])

  const clampPos = useCallback(
    (x: number, y: number) => ({
      x: Math.max(PAD, Math.min(x, window.innerWidth - size.width - PAD)),
      y: Math.max(PAD, Math.min(y, window.innerHeight - size.height - DRAG_BAR_H - PAD)),
    }),
    [size.width, size.height]
  )

  // ── Drag handlers ──
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button')) return
    isDragging.current = false
    dragging.current = true
    dragStartPos.current = { x: e.clientX, y: e.clientY }
    offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [pos])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    if (!isDragging.current) {
      const dx = Math.abs(e.clientX - dragStartPos.current.x)
      const dy = Math.abs(e.clientY - dragStartPos.current.y)
      if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return
      isDragging.current = true
    }
    const raw = { x: e.clientX - offset.current.x, y: e.clientY - offset.current.y }
    setPos(clampPos(raw.x, raw.y))
  }, [clampPos])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    dragging.current = false
    if (isDragging.current) {
      e.preventDefault()
      e.stopPropagation()
      requestAnimationFrame(() => {
        setPos((prev) => {
          updateFloatingAvatar({ x: prev.x, y: prev.y })
          return prev
        })
      })
    }
    isDragging.current = false
  }, [updateFloatingAvatar])

  // ── Resize handlers ──
  const handleResizeDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    resizing.current = true
    resizeStart.current = { x: e.clientX, y: e.clientY, w: size.width, h: size.height }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [size])

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizing.current) return
    const dx = e.clientX - resizeStart.current.x
    const dy = e.clientY - resizeStart.current.y
    const delta = Math.max(dx, dy)
    const ratio = aspectRatio.current
    const { maxW, maxH } = getViewportMax()

    let newWidth = resizeStart.current.w + delta
    newWidth = Math.max(MIN_SIZE, Math.min(maxW, newWidth))
    let newHeight = Math.round(newWidth / ratio)

    if (newHeight > maxH) {
      newHeight = maxH
      newWidth = Math.round(newHeight * ratio)
    } else if (newHeight < MIN_SIZE) {
      newHeight = MIN_SIZE
      newWidth = Math.round(newHeight * ratio)
    }

    setSize({ width: newWidth, height: newHeight })
    setPos((prev) => ({
      x: Math.max(PAD, Math.min(prev.x, window.innerWidth - newWidth - PAD)),
      y: Math.max(PAD, Math.min(prev.y, window.innerHeight - newHeight - DRAG_BAR_H - PAD)),
    }))
  }, [])

  const handleResizeUp = useCallback((e: React.PointerEvent) => {
    if (!resizing.current) return
    resizing.current = false
    e.preventDefault()
    e.stopPropagation()
    updateFloatingAvatar({ width: size.width, height: size.height, x: pos.x, y: pos.y })
  }, [size, pos, updateFloatingAvatar])

  if (!floatingAvatar) return null

  const containerClass = [
    styles.container,
    dragging.current ? styles.containerDragging : '',
  ].filter(Boolean).join(' ')

  return createPortal(
    <div
      className={containerClass}
      style={{
        left: pos.x,
        top: pos.y,
        width: size.width,
        height: size.height + DRAG_BAR_H,
      }}
    >
      {/* Drag handle */}
      <div
        className={styles.dragHandle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <span className={styles.handleName}>{floatingAvatar.displayName}</span>
        <button type="button" className={styles.handleBtn} onClick={(e) => { e.stopPropagation(); closeFloatingAvatar() }}>
          <X size={12} />
        </button>
      </div>

      {/* Avatar image area */}
      <div
        className={styles.imageContainer}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <LazyImage
          src={floatingAvatar.imageUrl}
          alt={floatingAvatar.displayName}
          className={styles.avatarImg}
          style={{ objectFit: 'contain' }}
          draggable={false}
          spinnerSize={28}
        />
      </div>

      {/* Resize handle */}
      <div
        className={styles.resizeHandle}
        onPointerDown={handleResizeDown}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeUp}
      />
    </div>,
    document.body
  )
}
