import { useRef, useCallback } from 'react'

export interface LongPressPos {
  x: number
  y: number
}

interface UseLongPressOptions {
  delay?: number
  moveThreshold?: number
  onLongPress: (pos: LongPressPos) => void
}

/**
 * Returns event handlers that trigger a callback on right-click (desktop)
 * or touch-and-hold (mobile). Cancels if the finger moves beyond a threshold.
 */
export function useLongPress({ onLongPress, delay = 500, moveThreshold = 10 }: UseLongPressOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPos = useRef<LongPressPos>({ x: 0, y: 0 })
  const targetRef = useRef<Element | null>(null)
  const firedRef = useRef(false)

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    firedRef.current = false
    const touch = e.touches[0]
    startPos.current = { x: touch.clientX, y: touch.clientY }
    targetRef.current = e.target instanceof Element ? e.target : null
    clear()
    timerRef.current = setTimeout(() => {
      const target = targetRef.current
      targetRef.current = null
      if (!target) return
      firedRef.current = true
      navigator.vibrate?.(50)
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
      }))
    }, delay)
  }, [delay, clear])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!timerRef.current) return
    const touch = e.touches[0]
    const dx = Math.abs(touch.clientX - startPos.current.x)
    const dy = Math.abs(touch.clientY - startPos.current.y)
    if (dx > moveThreshold || dy > moveThreshold) {
      clear()
    }
  }, [moveThreshold, clear])

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    clear()
    if (firedRef.current) {
      e.preventDefault()
      firedRef.current = false
    }
  }, [clear])

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onLongPress({ x: e.clientX, y: e.clientY })
  }, [onLongPress])

  return { onTouchStart, onTouchMove, onTouchEnd, onContextMenu }
}
