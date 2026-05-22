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
  const nativeListenerTargetRef = useRef<Element | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Capture-phase contextmenu suppressor — iOS dispatches a contextmenu event
  // when the image-lift/preview gesture starts. Catching it at capture phase
  // on the touch target stops the native preview before our synthetic event
  // fires. React's onContextMenu runs at bubble phase, which can be too late.
  const suppressNativeContextMenu = useCallback((e: Event) => {
    e.preventDefault()
  }, [])

  const detachNativeContextMenu = useCallback(() => {
    if (nativeListenerTargetRef.current) {
      nativeListenerTargetRef.current.removeEventListener('contextmenu', suppressNativeContextMenu, true)
      nativeListenerTargetRef.current = null
    }
  }, [suppressNativeContextMenu])

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    firedRef.current = false
    const touch = e.touches[0]
    startPos.current = { x: touch.clientX, y: touch.clientY }
    const target = e.target instanceof Element ? e.target : null
    targetRef.current = target

    detachNativeContextMenu()
    if (target) {
      target.addEventListener('contextmenu', suppressNativeContextMenu, true)
      nativeListenerTargetRef.current = target
    }

    clear()
    timerRef.current = setTimeout(() => {
      const t = targetRef.current
      targetRef.current = null
      if (!t) return
      firedRef.current = true
      navigator.vibrate?.(50)
      t.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
      }))
    }, delay)
  }, [delay, clear, detachNativeContextMenu, suppressNativeContextMenu])

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
    detachNativeContextMenu()
    if (firedRef.current) {
      e.preventDefault()
      firedRef.current = false
    }
  }, [clear, detachNativeContextMenu])

  const onTouchCancel = useCallback(() => {
    clear()
    detachNativeContextMenu()
    firedRef.current = false
  }, [clear, detachNativeContextMenu])

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onLongPress({ x: e.clientX, y: e.clientY })
  }, [onLongPress])

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, onContextMenu }
}
