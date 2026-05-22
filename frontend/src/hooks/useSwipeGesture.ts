import { useEffect, useRef } from 'react'

interface UseSwipeGestureOptions {
  enabled: boolean
  onSwipeLeft: () => void
  onSwipeRight: () => void
  threshold?: number         // px displacement, default 50
  velocityThreshold?: number // px/ms, default 0.3
}

// True if there's a non-collapsed selection whose range sits inside `el`.
// Used to bail out of a swipe when the user is actually extending a native
// text selection (long-press-then-drag) on touch.
function hasActiveSelectionWithin(el: HTMLElement): boolean {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i)
    if (el.contains(range.commonAncestorContainer)) return true
  }
  return false
}

/**
 * Touch gesture hook for horizontal swipe detection.
 * Attaches native event listeners to the ref'd element with { passive: false }
 * so we can preventDefault on horizontal moves without blocking vertical scroll.
 *
 * Uses a 10px dead zone + axis-lock pattern:
 * - If vertical wins at the lock point, gesture is abandoned (scroll proceeds)
 * - If horizontal wins, preventDefault claims the gesture
 *
 * Additionally: if a native text selection is active inside the element at
 * touchstart, or becomes active during the touch (e.g. iOS long-press → drag
 * to extend), the gesture is abandoned so the OS keeps the selection drag.
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

      // If a native text selection inside this element is already active,
      // the touch is most likely the user extending that selection — don't
      // arm the swipe at all.
      if (hasActiveSelectionWithin(el)) {
        locked = 'vertical'
        return
      }

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

      // If a selection became active during this touch (long-press finished
      // mid-drag and the OS started selection-extension), abandon the swipe
      // so we don't preventDefault the OS's selection move events.
      if (hasActiveSelectionWithin(el)) {
        locked = 'vertical'
        return
      }

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
