import { useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { getUiScale } from '@/lib/uiScale'
import { clampDrawerWidth, drawerWidthFromDelta } from '@/lib/drawer-width'

export function useDrawerResize(drawerRef: React.RefObject<HTMLDivElement | null>, side: 'left' | 'right', onCommit: (width: number) => void) {
  const [draftWidth, setDraftWidth] = useState<number | null>(null)
  const drag = useRef<{ id: number; x: number; width: number; latest: number; scale: number; viewport: number } | null>(null)
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    drag.current = null
    if (!cancel) onCommit(active.latest)
    setDraftWidth(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return {
    draftWidth,
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !event.isPrimary || !drawerRef.current) return
        event.preventDefault()
        const scale = getUiScale()
        const width = drawerRef.current.getBoundingClientRect().width / scale
        drag.current = { id: event.pointerId, x: event.clientX, width, latest: width, scale, viewport: window.innerWidth / scale }
        event.currentTarget.setPointerCapture(event.pointerId)
        setDraftWidth(width)
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        const active = drag.current
        if (!active || active.id !== event.pointerId) return
        active.latest = drawerWidthFromDelta(active.width, event.clientX - active.x, side, active.scale, active.viewport)
        setDraftWidth(active.latest)
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => finish(event),
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!drawerRef.current || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
        event.preventDefault()
        const scale = getUiScale()
        const current = drawerRef.current.getBoundingClientRect().width / scale
        onCommit(event.key === 'Home' ? clampDrawerWidth(420, window.innerWidth / scale) : drawerWidthFromDelta(current, (event.key === 'ArrowRight' ? 20 : -20) * scale, side, scale, window.innerWidth / scale))
      },
    },
  }
}
