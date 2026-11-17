import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { getUiScale, layoutElementRect, toLayoutDelta, type LayoutRect } from '@/lib/uiScale'

type GestureKind = 'dock' | 'move' | 'resize'
type Point = { x: number; y: number }
type Gesture = {
  kind: GestureKind
  rect: LayoutRect
  start: Point
  points: Map<number, Point>
  pinch?: number
}

const compactDock = '(max-width: 600px)'
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const point = (event: PointerEvent): Point => ({ x: event.clientX, y: event.clientY })

export function useGuidePlacement(mode: 'dock' | 'widget' | null, side: 'left' | 'right') {
  const shell = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [compact, setCompact] = useState(() => window.matchMedia?.(compactDock)?.matches ?? false)
  const [dockSize, setDockSize] = useState<{ width?: number; height?: number }>({})
  const [widget, setWidget] = useState<LayoutRect>()
  const [dockPercent, setDockPercent] = useState(50)

  useLayoutEffect(() => () => { gesture.current = null }, [mode])

  useLayoutEffect(() => {
    const media = window.matchMedia?.(compactDock)
    if (!media) return
    const update = () => setCompact(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useLayoutEffect(() => {
    const panel = shell.current
    if (mode !== 'dock' || !panel) return
    const root = document.documentElement
    root.dataset.guideDocked = ''
    const edge = compact ? 'bottom' : side
    const property = '--guide-dock-' + edge
    const update = () => {
      const rect = layoutElementRect(panel)
      const scale = getUiScale()
      const occupied = compact ? window.innerHeight / scale - rect.y
        : side === 'left' ? rect.x + rect.width : window.innerWidth / scale - rect.x
      root.style.setProperty(property, Math.max(0, occupied) + 'px')
      const viewport = (compact ? window.innerHeight : window.innerWidth) / scale
      setDockPercent(viewport > 0 ? Math.round(100 * occupied / viewport) : 50)
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(panel)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      root.style.removeProperty(property)
      delete root.dataset.guideDocked
    }
  }, [mode, side, compact])

  function change(kind: GestureKind, rect: LayoutRect, dx: number, dy: number) {
    if (kind === 'dock') {
      if (compact) setDockSize((size) => ({ ...size, height: rect.height - dy }))
      else setDockSize((size) => ({ ...size, width: rect.width + (side === 'left' ? dx : -dx) }))
    } else if (kind === 'move') {
      setWidget({ ...rect, x: rect.x + dx, y: rect.y + dy })
    } else {
      setWidget({ ...rect, width: rect.width + dx, height: rect.height + dy })
    }
  }

  function controls(kind: GestureKind) {
    function end(event: PointerEvent<HTMLElement>) {
      if (gesture.current?.points.has(event.pointerId)) gesture.current = null
    }

    return {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (event.button !== 0 || !shell.current) return
        const current = gesture.current
        if (current) {
          if (kind !== 'move' || current.kind !== kind || event.pointerType !== 'touch' || current.points.size !== 1) return
          const first = current.points.values().next().value!
          current.points.set(event.pointerId, point(event))
          current.rect = layoutElementRect(shell.current)
          current.pinch = Math.max(1, distance(first, point(event)))
        } else {
          const start = point(event)
          gesture.current = { kind, start, rect: layoutElementRect(shell.current), points: new Map([[event.pointerId, start]]) }
        }
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const current = gesture.current
        if (!current?.points.has(event.pointerId) || current.kind !== kind) return
        const next = point(event)
        current.points.set(event.pointerId, next)
        if (current.pinch !== undefined) {
          const [a, b] = current.points.values()
          const ratio = distance(a, b) / current.pinch
          const { width, height } = current.rect
          change('resize', current.rect, width * (ratio - 1), height * (ratio - 1))
        } else {
          const delta = toLayoutDelta(next.x - current.start.x, next.y - current.start.y)
          change(kind, current.rect, delta.x, delta.y)
        }
      },
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (!shell.current) return
        const step = event.shiftKey ? 48 : 16
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
        if (!dx && !dy || kind === 'dock' && (compact ? !dy : !dx)) return
        event.preventDefault()
        change(kind, layoutElementRect(shell.current), dx, dy)
      },
    }
  }

  return { shell, compact, dockSize, dockPercent, widget, controls }
}
