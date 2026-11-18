import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEventHandler, type PointerEvent, type ReactNode } from 'react'
import { MIN_EXPRESSION_DOCK_PERCENT } from '@/types/expressions'
import styles from './ExpressionDisplay.module.css'

interface ExpressionDockProps {
  edge: 'left' | 'right' | 'top'
  size: number
  maxSize: number
  onSizeChange: (size: number) => void
  resizeLabel: string
  background: boolean
  opacity: number
  onContextMenu: MouseEventHandler<HTMLDivElement>
  controls: ReactNode
  children: ReactNode
}

interface ResizeGesture {
  pointerId: number
  start: number
  size: number
  extent: number
}

export default function ExpressionDock({
  edge, size, maxSize, onSizeChange, resizeLabel, background, opacity, onContextMenu, controls, children,
}: ExpressionDockProps) {
  const isTop = edge === 'top'
  const dockRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const dock = dockRef.current
    const workspace = dock?.parentElement
    if (edge === 'top' || !dock || !workspace) return

    // Chat already gives the dock this width in the flex row.
    const property = '--expression-dock-' + edge
    const syncWidth = () => workspace.style.setProperty(property, dock.offsetWidth + 'px')
    const observer = new ResizeObserver(syncWidth)
    observer.observe(dock)
    syncWidth()
    return () => {
      observer.disconnect()
      workspace.style.removeProperty(property)
    }
  }, [edge])

  const gesture = useRef<ResizeGesture | null>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const displayedSize = preview ?? size
  const clamp = (value: number) => Math.max(MIN_EXPRESSION_DOCK_PERCENT, Math.min(maxSize, Math.round(value)))
  const coordinate = (event: PointerEvent) => isTop ? event.clientY : event.clientX

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || gesture.current) return
    const workspace = dockRef.current?.parentElement?.getBoundingClientRect()
    const extent = isTop ? workspace?.height : workspace?.width
    if (!extent) return

    gesture.current = { pointerId: event.pointerId, start: coordinate(event), size, extent }
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function sizeFromPointer(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current
    if (current?.pointerId !== event.pointerId) return null
    const delta = (coordinate(event) - current.start) * 100 / current.extent
    return clamp(current.size + (edge === 'right' ? -delta : delta))
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const next = sizeFromPointer(event)
    if (next !== null) setPreview(next)
  }

  function cancelResize(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId !== event.pointerId) return
    gesture.current = null
    setPreview(null)
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const next = sizeFromPointer(event)
    cancelResize(event)
    if (next !== null && next !== size) onSizeChange(next)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 10 : 2
    const shrinkKey = isTop ? 'ArrowUp' : edge === 'left' ? 'ArrowLeft' : 'ArrowRight'
    const expandKey = isTop ? 'ArrowDown' : edge === 'left' ? 'ArrowRight' : 'ArrowLeft'
    let next: number
    switch (event.key) {
      case shrinkKey: next = size - step; break
      case expandKey: next = size + step; break
      case 'Home': next = MIN_EXPRESSION_DOCK_PERCENT; break
      case 'End': next = maxSize; break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    const constrained = clamp(next)
    if (constrained !== size) onSizeChange(constrained)
  }

  return (
    <div
      ref={dockRef}
      className={styles.dock}
      data-expression-dock={edge}
      data-dock-background={background || undefined}
      style={{
        '--expression-dock-size': `${displayedSize}%`,
        '--expression-dock-media-scale': `${displayedSize / maxSize * 100}%`,
      } as CSSProperties}
      onContextMenu={onContextMenu}
    >
      <div className={styles.dockMedia} style={{ opacity }}>
        {children}
      </div>
      <div
        className={styles.dockResizeHandle}
        role="separator"
        tabIndex={0}
        aria-label={resizeLabel}
        aria-orientation={isTop ? 'horizontal' : 'vertical'}
        aria-valuemin={MIN_EXPRESSION_DOCK_PERCENT}
        aria-valuemax={maxSize}
        aria-valuenow={displayedSize}
        data-resizing={preview !== null || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelResize}
        onLostPointerCapture={cancelResize}
        onKeyDown={onKeyDown}
      />
      {controls}
    </div>
  )
}
