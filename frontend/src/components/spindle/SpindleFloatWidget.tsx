import { useRef, useCallback, useEffect, useState } from 'react'
import type { FloatWidgetState } from '@/store/slices/spindle-placement'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import styles from './SpindleFloatWidget.module.css'

interface Props {
  widget: FloatWidgetState
}

export default function SpindleFloatWidget({ widget }: Props) {
  const updateFloatWidget = useStore((s) => s.updateFloatWidget)
  const setPlacementHidden = useStore((s) => s.setPlacementHidden)
  const isMobile = useIsMobile()

  const dragging = useRef(false)
  const offset = useRef({ x: 0, y: 0 })
  const [pos, setPos] = useState({ x: widget.x, y: widget.y })
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const size = isMobile
    ? { width: Math.min(widget.width, 40), height: Math.min(widget.height, 40) }
    : { width: widget.width, height: widget.height }

  useEffect(() => {
    setPos({ x: widget.x, y: widget.y })
  }, [widget.x, widget.y])

  const clampPos = useCallback(
    (x: number, y: number) => {
      const pad = 12
      return {
        x: Math.max(pad, Math.min(x, window.innerWidth - size.width - pad)),
        y: Math.max(pad, Math.min(y, window.innerHeight - size.height - pad)),
      }
    },
    [size.width, size.height]
  )

  const snapToEdge = useCallback(
    (x: number, y: number) => {
      if (!widget.snapToEdge) return { x, y }
      const snapDist = 24
      const pad = 12
      const vw = window.innerWidth
      const vh = window.innerHeight
      let sx = x, sy = y
      if (x < snapDist) sx = pad
      else if (x + size.width > vw - snapDist) sx = vw - size.width - pad
      if (y < snapDist) sy = pad
      else if (y + size.height > vh - snapDist) sy = vh - size.height - pad
      return { x: sx, y: sy }
    },
    [widget.snapToEdge, size.width, size.height]
  )

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    dragging.current = true
    offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [pos])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    const raw = { x: e.clientX - offset.current.x, y: e.clientY - offset.current.y }
    setPos(clampPos(raw.x, raw.y))
  }, [clampPos])

  const handlePointerUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    let snapped = { x: 0, y: 0 }
    setPos((prev) => {
      snapped = snapToEdge(prev.x, prev.y)
      return snapped
    })
    // Defer store update out of React's state-computation phase to avoid
    // triggering a SpindleUIManager re-render while this component is mid-render.
    requestAnimationFrame(() => {
      updateFloatWidget(widget.id, snapped)
      window.dispatchEvent(
        new CustomEvent('spindle:float-drag-end', {
          detail: { widgetId: widget.id, ...snapped },
        })
      )
    })
  }, [snapToEdge, updateFloatWidget, widget.id])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const dismiss = () => setContextMenu(null)
    window.addEventListener('click', dismiss)
    return () => window.removeEventListener('click', dismiss)
  }, [contextMenu])

  if (!widget.visible) return null

  return (
    <>
      <div
        className={`${styles.widget}${widget.chromeless ? ` ${styles.chromeless}` : ''}`}
        style={{
          left: pos.x,
          top: pos.y,
          width: size.width,
          height: size.height,
        }}
        title={widget.tooltip}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onContextMenu={handleContextMenu}
      >
        <div className={styles.content} ref={(el) => {
          if (el && !el.contains(widget.root)) {
            el.replaceChildren(widget.root)
          }
        }} />
      </div>

      {contextMenu && (
        <div
          className={styles.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className={styles.contextMenuItem}
            onClick={() => {
              setPlacementHidden(widget.id, true)
              setContextMenu(null)
            }}
          >
            Hide Widget
          </button>
          <button
            className={styles.contextMenuItem}
            onClick={() => {
              const reset = {
                x: window.innerWidth - size.width - 16,
                y: window.innerHeight - size.height - 16,
              }
              setPos(reset)
              updateFloatWidget(widget.id, reset)
              setContextMenu(null)
            }}
          >
            Reset Position
          </button>
        </div>
      )}
    </>
  )
}
