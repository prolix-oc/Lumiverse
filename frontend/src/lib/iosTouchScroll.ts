import { usesNativeWidgetTouchScroll } from './spindle/widget-touch-scroll'

type InputTouch = Touch & { touchType?: 'direct' | 'stylus' }

const TAP_SLOP = 10 // CSS pixels, matching the composer and touch activation guards.

function isStylus(touch: Touch): boolean {
  return (touch as InputTouch).touchType === 'stylus'
}

/** WebKit includes Pencil input in Touch Events as well as Pointer Events. */
export function isStylusTouchEvent(event: TouchEvent): boolean {
  // Only examine the points that changed: a resting palm may still be present
  // in touches while the Pencil moves. Unknown touch types remain finger input.
  const changed = event.changedTouches.length ? event.changedTouches : event.touches
  return changed.length > 0 && Array.from(changed).every(isStylus)
}

/** Suppress page pinch zoom without consuming Pencil input or Pencil + palm. */
export function preventPageTouchZoom(event: TouchEvent): void {
  if (isStylusTouchEvent(event)) return
  if (Array.from(event.touches).filter(touch => !isStylus(touch)).length > 1) {
    event.preventDefault()
  }
}

function findScrollableAncestor(el: Element | null): { el: Element; horizontal: boolean } | null {
  while (el && el !== document.body && el !== document.documentElement) {
    const style = window.getComputedStyle(el)
    const scrollableY = (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight
    const scrollableX = (style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth
    if (scrollableY || scrollableX) return { el, horizontal: scrollableX && !scrollableY }
    el = el.parentElement
  }
  return null
}

/** Guard installed-iOS page overscroll while leaving native taps intact. */
export function installIOSTouchScrollGuard(): () => void {
  let start: {
    id: number
    x: number
    y: number
    moved: boolean
    scrollTarget: ReturnType<typeof findScrollableAncestor>
  } | null = null

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0]
    start = event.touches.length === 1 && touch && !isStylus(touch) ? {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      moved: false,
      scrollTarget: findScrollableAncestor(event.target instanceof Element ? event.target : null),
    } : null
  }

  const onTouchMove = (event: TouchEvent) => {
    if (isStylusTouchEvent(event)) return
    if (event.touches.length !== 1) { start = null; return }
    const touch = event.touches[0]
    if (!start || touch.identifier !== start.id || isStylus(touch)) return
    // Only an explicitly opted-in live widget owns its single-finger scrolling.
    if (usesNativeWidgetTouchScroll(event)) return
    // Let the browser pan the magnified page.
    if (Math.abs((window.visualViewport?.scale ?? 1) - 1) > 0.01) return

    const deltaX = start.x - touch.clientX
    const deltaY = start.y - touch.clientY
    // Canceling even a tiny touchmove can suppress the native click. Wait until
    // this is a swipe, and leave Pencil moves to their target throughout.
    if (!start.moved && Math.hypot(deltaX, deltaY) <= TAP_SLOP) return
    start.moved = true

    // Don't interfere with horizontal scrolling (carousels, tab bars, sliders).
    if (Math.abs(deltaX) > Math.abs(deltaY) + 5) return
    if (start.scrollTarget?.horizontal) return

    if (start.scrollTarget) {
      const { el } = start.scrollTarget
      const atTop = el.scrollTop <= 0 && deltaY < 0
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && deltaY > 0
      if (atTop || atBottom) event.preventDefault()
    } else {
      event.preventDefault()
    }
  }

  const reset = () => { start = null }
  document.addEventListener('touchstart', onTouchStart, { passive: true })
  document.addEventListener('touchmove', onTouchMove, { passive: false })
  document.addEventListener('touchend', reset, { passive: true })
  document.addEventListener('touchcancel', reset, { passive: true })
  return () => {
    document.removeEventListener('touchstart', onTouchStart)
    document.removeEventListener('touchmove', onTouchMove)
    document.removeEventListener('touchend', reset)
    document.removeEventListener('touchcancel', reset)
    reset()
  }
}
