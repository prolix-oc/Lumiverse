import { useRef } from 'react'
import type { PointerEvent } from 'react'
import styles from './WorldBookColumnHandle.module.css'

interface Props {
  label: string
  width: number
  defaultWidth: number
  min: number
  max: number
  collapseBelow: number
  onResize: (width: number) => void
  onCollapse: () => void
}

export default function WorldBookColumnHandle({ label, width, defaultWidth, min, max, collapseBelow, onResize, onCollapse }: Props) {
  const drag = useRef<{ pointer: number; x: number; width: number; scale: number; desired: number } | null>(null)
  const clamp = (value: number) => Math.max(min, Math.min(max, value))
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const current = drag.current
    if (!current || current.pointer !== event.pointerId) return
    if (!cancel) current.desired = current.width + (event.clientX - current.x) / current.scale
    drag.current = null
    if (cancel) onResize(current.width)
    else if (current.desired < collapseBelow) { onResize(current.width); onCollapse() }
    else onResize(clamp(current.desired))
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <div role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
    tabIndex={0} className={styles.handle} title="Drag to resize; drag left to collapse. Arrow keys resize, Home resets, End collapses."
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return
      const element = event.currentTarget
      const scale = element.getBoundingClientRect().width / element.offsetWidth || 1
      drag.current = { pointer: event.pointerId, x: event.clientX, width, scale, desired: width }
      element.focus({ preventScroll: true })
      element.setPointerCapture(event.pointerId)
      event.preventDefault()
    }}
    onPointerMove={event => {
      const current = drag.current
      if (!current || current.pointer !== event.pointerId) return
      current.desired = current.width + (event.clientX - current.x) / current.scale
      onResize(clamp(current.desired))
    }}
    onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
    onLostPointerCapture={event => { const current = drag.current; if (current?.pointer === event.pointerId) { drag.current = null; onResize(current.width) } }}
    onKeyDown={event => {
      if (event.key === 'Escape' && drag.current) { const current = drag.current; drag.current = null; onResize(current.width); if (event.currentTarget.hasPointerCapture(current.pointer)) event.currentTarget.releasePointerCapture(current.pointer); event.preventDefault(); event.stopPropagation(); return }
      if (drag.current) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onResize(clamp(width + (event.key === 'ArrowLeft' ? -16 : 16))) }
      else if (event.key === 'Home') { event.preventDefault(); onResize(defaultWidth) }
      else if (event.key === 'End') { event.preventDefault(); onCollapse() }
    }} />
}
