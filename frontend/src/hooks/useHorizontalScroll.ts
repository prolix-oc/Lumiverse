import { useRef, useState, useEffect, useCallback, RefObject } from 'react'

interface ScrollState {
  canScrollLeft: boolean
  canScrollRight: boolean
}

/**
 * Hooks up a container so that:
 *  - vertical wheel events are translated into horizontal scrolling
 *  - mouse drag-to-scroll works on desktop
 *  - native touch scrolling continues to work on mobile
 *  - scroll indicators (canScrollLeft / canScrollRight) are reported
 *
 * The caller should attach the returned ref to the scrollable element.
 */
export default function useHorizontalScroll<T extends HTMLElement>(): [
  RefObject<T | null>,
  ScrollState
] {
  const ref = useRef<T | null>(null)
  const [scrollState, setScrollState] = useState<ScrollState>({
    canScrollLeft: false,
    canScrollRight: false,
  })

  const updateScrollState = useCallback(() => {
    const el = ref.current
    if (!el) return
    const maxScroll = el.scrollWidth - el.clientWidth
    const canScrollLeft = el.scrollLeft > 1
    const canScrollRight = el.scrollLeft < maxScroll - 1
    setScrollState((prev) => {
      if (
        prev.canScrollLeft === canScrollLeft &&
        prev.canScrollRight === canScrollRight
      ) {
        return prev
      }
      return { canScrollLeft, canScrollRight }
    })
  }, [])

  // wheel → horizontal scroll
  useEffect(() => {
    const el = ref.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      // If the user is holding Shift, the OS/browser already maps
      // vertical wheel to horizontal scroll on many platforms — let it
      // pass through untouched.
      if (e.shiftKey) return

      const hasHorizontalOverflow = el.scrollWidth > el.clientWidth
      if (!hasHorizontalOverflow) return

      // If we're at the left edge and scrolling up, or at the right edge
      // and scrolling down, let the event propagate (rubber-band feel).
      const atLeft = el.scrollLeft <= 0 && e.deltaY < 0
      const atRight =
        el.scrollLeft >= el.scrollWidth - el.clientWidth && e.deltaY > 0
      if (atLeft || atRight) return

      e.preventDefault()
      e.stopPropagation()
      el.scrollLeft += e.deltaY
      updateScrollState()
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [updateScrollState])

  // drag-to-scroll for desktop mice
  useEffect(() => {
    const el = ref.current
    if (!el) return

    let isDragging = false
    let startX = 0
    let scrollStart = 0

    const onPointerDown = (e: PointerEvent) => {
      // Desktop mouse only. Touch keeps native scrolling, and interactive
      // descendants (member buttons, add button, etc.) keep their own clicks.
      if (e.pointerType !== 'mouse' || e.button !== 0) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('button, a, input, textarea, select, [role="button"], [data-no-drag-scroll]')) {
        return
      }
      isDragging = true
      startX = e.clientX
      scrollStart = el.scrollLeft
      el.setPointerCapture(e.pointerId)
      el.style.cursor = 'grabbing'
      el.style.userSelect = 'none'
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return
      const dx = startX - e.clientX
      el.scrollLeft = scrollStart + dx
      updateScrollState()
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!isDragging) return
      isDragging = false
      el.releasePointerCapture(e.pointerId)
      el.style.cursor = ''
      el.style.userSelect = ''
      // If the drag was tiny, treat it as a click — do nothing here;
      // the member button's own onClick will fire.
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)

    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
    }
  }, [updateScrollState])

  // observe scroll / resize to update indicators
  useEffect(() => {
    const el = ref.current
    if (!el) return

    const onScroll = () => updateScrollState()
    el.addEventListener('scroll', onScroll, { passive: true })

    const ro = new ResizeObserver(() => updateScrollState())
    ro.observe(el)

    updateScrollState()

    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [updateScrollState])

  return [ref, scrollState]
}
