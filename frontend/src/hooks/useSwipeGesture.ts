import { useEffect, useRef } from 'react'

interface UseSwipeGestureOptions {
  enabled: boolean
  onSwipeLeft: () => void
  onSwipeRight: () => void
  threshold?: number         // px displacement, default 50
  velocityThreshold?: number // px/ms, default 0.3
}

/**
 * Touch gesture hook for horizontal swipe detection.
 * Attaches native event listeners to the ref'd element with { passive: false }
 * so we can preventDefault on horizontal moves without blocking vertical scroll.
 *
 * Uses a 10px dead zone + axis-lock pattern:
 * - If vertical wins at the lock point, gesture is abandoned (scroll proceeds)
 * - If horizontal wins, preventDefault claims the gesture
 */
export default function useSwipeGesture(
  ref: React.RefObject<HTMLElement | null>,
  options: UseSwipeGestureOptions
): void {
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const DEAD_ZONE = 10
    const DEFAULT_THRESHOLD = 50
    const DEFAULT_VELOCITY = 0.3

    let startX = 0
    let startY = 0
    let startTime = 0
    let locked: 'horizontal' | 'vertical' | null = null
    let currentX = 0

    const onTouchStart = (e: TouchEvent) => {
      if (!optionsRef.current.enabled) return
      if (e.touches.length !== 1) return

      const touch = e.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      startTime = Date.now()
      locked = null
      currentX = startX
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!optionsRef.current.enabled) return
      if (e.touches.length !== 1) return

      const touch = e.touches[0]
      const deltaX = touch.clientX - startX
      const deltaY = touch.clientY - startY

      if (locked === null) {
        const totalDisplacement = Math.abs(deltaX) + Math.abs(deltaY)
        if (totalDisplacement < DEAD_ZONE) return

        // Lock to dominant axis
        locked = Math.abs(deltaX) >= Math.abs(deltaY) ? 'horizontal' : 'vertical'
      }

      if (locked === 'vertical') return

      // Horizontal lock — claim the gesture
      e.preventDefault()
      currentX = touch.clientX
    }

    const onTouchEnd = () => {
      if (!optionsRef.current.enabled) return
      if (locked !== 'horizontal') {
        locked = null
        return
      }

      const displacement = currentX - startX
      const elapsed = Date.now() - startTime
      const velocity = elapsed > 0 ? Math.abs(displacement) / elapsed : 0
      const threshold = optionsRef.current.threshold ?? DEFAULT_THRESHOLD
      const velocityThreshold = optionsRef.current.velocityThreshold ?? DEFAULT_VELOCITY

      if (Math.abs(displacement) >= threshold || velocity >= velocityThreshold) {
        if (displacement < 0) {
          optionsRef.current.onSwipeRight()
        } else {
          optionsRef.current.onSwipeLeft()
        }
      }

      locked = null
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: true })

    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [ref])
}
