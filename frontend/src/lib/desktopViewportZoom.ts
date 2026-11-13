import { getUiScale } from './uiScale'

export interface ViewportZoom {
  scale: number
  x: number
  y: number
}

export interface ViewportPoint { x: number; y: number }
export interface ViewportSize { width: number; height: number }

export const INITIAL_VIEWPORT_ZOOM: ViewportZoom = { scale: 1, x: 0, y: 0 }
export const MAX_VIEWPORT_ZOOM = 3

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function constrainViewportZoom(zoom: ViewportZoom, viewport: ViewportSize): ViewportZoom {
  const scale = clamp(Number.isFinite(zoom.scale) ? zoom.scale : 1, 1, MAX_VIEWPORT_ZOOM)
  if (scale === 1) return INITIAL_VIEWPORT_ZOOM
  return {
    scale,
    x: clamp(zoom.x, viewport.width * (1 - scale), 0),
    y: clamp(zoom.y, viewport.height * (1 - scale), 0),
  }
}

/** Keep the content under `startPoint` beneath `endPoint` as scale changes. */
export function zoomViewportFrom(
  start: ViewportZoom,
  nextScale: number,
  startPoint: ViewportPoint,
  endPoint: ViewportPoint,
  viewport: ViewportSize,
): ViewportZoom {
  const scale = clamp(nextScale, 1, MAX_VIEWPORT_ZOOM)
  const ratio = scale / start.scale
  return constrainViewportZoom({
    scale,
    x: endPoint.x - (startPoint.x - start.x) * ratio,
    y: endPoint.y - (startPoint.y - start.y) * ratio,
  }, viewport)
}

export function panViewport(start: ViewportZoom, delta: ViewportPoint, viewport: ViewportSize): ViewportZoom {
  return constrainViewportZoom({ ...start, x: start.x + delta.x, y: start.y + delta.y }, viewport)
}

function isMobileOS(): boolean {
  const userAgentData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  return userAgentData?.mobile === true || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function isDesktopViewportZoomAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof document !== 'undefined'
    && !isMobileOS() && !document.documentElement.hasAttribute('data-tauri-floating-widget')
}

function isLightboxEvent(event: Event): boolean {
  return event.target instanceof Element && Boolean(event.target.closest('[data-viewport-zoom-exempt]'))
}

function viewportSize(): ViewportSize {
  return { width: window.innerWidth, height: window.innerHeight }
}

function touchPoint(touch: Touch): ViewportPoint {
  return { x: touch.clientX, y: touch.clientY }
}

function touchMidpoint(touches: TouchList): ViewportPoint {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  }
}

function touchDistance(touches: TouchList): number {
  const a = touchPoint(touches[0])
  const b = touchPoint(touches[1])
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function wheelPixels(event: WheelEvent): ViewportPoint {
  const factor = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1
  return { x: event.deltaX * factor, y: event.deltaY * factor }
}

/** Installs session-only viewport magnification in the main desktop document. */
export function installDesktopViewportZoom(): () => void {
  if (!isDesktopViewportZoomAvailable()) return () => {}

  let zoom = INITIAL_VIEWPORT_ZOOM
  let touchStart: { zoom: ViewportZoom; point: ViewportPoint; distance: number } | null = null
  let gestureStart: { zoom: ViewportZoom; point: ViewportPoint } | null = null
  let pointer: ViewportPoint | null = null

  const apply = (next: ViewportZoom) => {
    zoom = constrainViewportZoom(next, viewportSize())
    if (zoom.scale === 1) {
      document.body.style.removeProperty('transform')
      document.body.style.removeProperty('transform-origin')
      return
    }
    // Body already carries UI Scale (CSS zoom, or individual scale on Linux).
    // Translation is in its layout pixels, so divide the rendered offset once.
    const uiScale = getUiScale()
    document.body.style.transformOrigin = 'top left'
    document.body.style.transform = `translate3d(${zoom.x / uiScale}px, ${zoom.y / uiScale}px, 0) scale(${zoom.scale})`
  }

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') pointer = { x: event.clientX, y: event.clientY }
  }

  const onWheel = (event: WheelEvent) => {
    if (isLightboxEvent(event)) return
    if (event.ctrlKey) {
      event.preventDefault()
      if (gestureStart || !event.deltaY) return
      const delta = wheelPixels(event)
      const point = { x: event.clientX, y: event.clientY }
      apply(zoomViewportFrom(zoom, zoom.scale * Math.exp(-delta.y * 0.01), point, point, viewportSize()))
      return
    }
    if (zoom.scale === 1) return
    event.preventDefault()
    const delta = wheelPixels(event)
    apply(panViewport(zoom, { x: -delta.x, y: -delta.y }, viewportSize()))
  }

  const onGestureStart = (event: Event) => {
    event.preventDefault()
    if (isLightboxEvent(event) || touchStart) return
    const gesture = event as Event & { clientX?: number; clientY?: number }
    gestureStart = {
      zoom,
      point: {
        x: Number.isFinite(gesture.clientX) ? gesture.clientX! : pointer?.x ?? window.innerWidth / 2,
        y: Number.isFinite(gesture.clientY) ? gesture.clientY! : pointer?.y ?? window.innerHeight / 2,
      },
    }
  }

  const onGestureChange = (event: Event) => {
    event.preventDefault()
    if (isLightboxEvent(event) || touchStart || !gestureStart) return
    const gesture = event as Event & { scale?: number }
    if (!Number.isFinite(gesture.scale) || !gesture.scale || gesture.scale <= 0) return
    apply(zoomViewportFrom(gestureStart.zoom, gestureStart.zoom.scale * gesture.scale,
      gestureStart.point, gestureStart.point, viewportSize()))
  }

  const onGestureEnd = () => { gestureStart = null }

  const onTouchStart = (event: TouchEvent) => {
    if (isLightboxEvent(event) || event.touches.length !== 2) {
      touchStart = null
      return
    }
    const distance = touchDistance(event.touches)
    if (distance > 0) touchStart = { zoom, point: touchMidpoint(event.touches), distance }
  }

  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length > 1) event.preventDefault()
    if (isLightboxEvent(event) || event.touches.length !== 2) return
    if (!touchStart) onTouchStart(event)
    if (!touchStart) return
    apply(zoomViewportFrom(touchStart.zoom,
      touchStart.zoom.scale * touchDistance(event.touches) / touchStart.distance,
      touchStart.point, touchMidpoint(event.touches), viewportSize()))
  }

  const onTouchEnd = () => { touchStart = null }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== '0' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
    event.preventDefault()
    apply(INITIAL_VIEWPORT_ZOOM)
  }

  const onResize = () => apply(zoom)
  const themeObserver = new MutationObserver(() => {
    if (zoom.scale !== 1) apply(zoom)
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })

  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('wheel', onWheel, { passive: false })
  document.addEventListener('gesturestart', onGestureStart, { passive: false })
  document.addEventListener('gesturechange', onGestureChange, { passive: false })
  document.addEventListener('gestureend', onGestureEnd)
  document.addEventListener('touchstart', onTouchStart, { passive: true })
  document.addEventListener('touchmove', onTouchMove, { passive: false })
  document.addEventListener('touchend', onTouchEnd)
  document.addEventListener('touchcancel', onTouchEnd)
  document.addEventListener('keydown', onKeyDown)
  window.addEventListener('resize', onResize)

  return () => {
    themeObserver.disconnect()
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('wheel', onWheel)
    document.removeEventListener('gesturestart', onGestureStart)
    document.removeEventListener('gesturechange', onGestureChange)
    document.removeEventListener('gestureend', onGestureEnd)
    document.removeEventListener('touchstart', onTouchStart)
    document.removeEventListener('touchmove', onTouchMove)
    document.removeEventListener('touchend', onTouchEnd)
    document.removeEventListener('touchcancel', onTouchEnd)
    document.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('resize', onResize)
    apply(INITIAL_VIEWPORT_ZOOM)
  }
}
