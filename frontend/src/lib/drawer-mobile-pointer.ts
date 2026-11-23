import type { DrawerSidebarDropSide } from './drawer-sidebar-drop'

/** The mobile arrange gesture is independent of dnd-kit's delayed touch sensor.
 * Its pointer capture survives movement across other buttons and the scroll rail.
 * The saved layout still goes through applyDrawerSidebarDrop, exactly as on desktop. */
export interface DrawerMobilePointer {
  pointerId: number
  pointerType: string
  isPrimary: boolean
  button: number
  clientX: number
  clientY: number
  currentTarget: HTMLElement
  preventDefault(): void
}

export interface DrawerMobileDragCallbacks {
  onStart(id: string): void
  onHover(id: string, overId: string | null, side: DrawerSidebarDropSide): void
  onDrop(id: string, overId: string | null, side: DrawerSidebarDropSide): void
  onCancel(): void
}

type MobileSession = {
  id: string
  pointerId: number
  element: HTMLElement
  captureElement: HTMLElement
  rail: HTMLElement
  horizontal: boolean
  startRect: DOMRect
  startScroll: number
  startX: number
  startY: number
  x: number
  y: number
  started: boolean
  holdTimer: ReturnType<typeof setTimeout> | null
  scrollFrame: number | null
  callbacks: DrawerMobileDragCallbacks
}

const MOVE_THRESHOLD_PX = 6
const HOLD_TO_LIFT_MS = 180
const SCROLL_EDGE_PX = 34
// A 12px divider half is fine for a mouse but too precise for a fingertip.
// Snap to nearby divider edges without enlarging the visible separator.
const DIVIDER_TOUCH_SNAP_PX = 10

export function drawerMobilePointerDropSide(
  clientX: number,
  target: Pick<DOMRect, 'left' | 'width' | 'top' | 'height'>,
  clientY = 0,
  horizontal = true,
): DrawerSidebarDropSide {
  const size = horizontal ? target.width : target.height
  if (size <= 0) return 'inside'
  const fraction = (horizontal ? clientX - target.left : clientY - target.top) / size
  return fraction < 0.25 ? 'before' : fraction > 0.75 ? 'after' : 'inside'
}

function isHorizontalRail(rail: HTMLElement): boolean {
  // Coarse pointers also exist on desktop-width touchscreens, whose rail is vertical.
  return rail.ownerDocument.defaultView?.getComputedStyle(rail).flexDirection !== 'column'
}

/** Dividers are insertion *boundaries*, not tiny buttons. On a horizontal
 * mobile rail their 28px cross-axis hitboxes are shorter than labeled tabs
 * and expanded folders. A finger sliding along the tab centerline can miss
 * elementFromPoint entirely, even though it is directly over the divider.
 * Resolve the visible divider along the rail's primary axis, with a small
 * finger-friendly margin before/after. This also works on vertical touch
 * rails and after the rail scrolls, since bounds are read live each move.
 */
function findNearbyDividerBoundary(
  rail: HTMLElement,
  clientX: number,
  clientY: number,
  horizontal: boolean,
): { id: string; side: DrawerSidebarDropSide } | null {
  const railRect = rail.getBoundingClientRect()
  const coordinate = horizontal ? clientX : clientY
  const railStart = horizontal ? railRect.left : railRect.top
  const railEnd = horizontal ? railRect.right : railRect.bottom
  let closest: { id: string; side: DrawerSidebarDropSide; distance: number } | null = null

  for (const child of Array.from(rail.children)) {
    if (!child.hasAttribute('data-drawer-divider')) continue
    const rect = child.getBoundingClientRect()
    const start = horizontal ? rect.left : rect.top
    const end = horizontal ? rect.right : rect.bottom
    // Ignore hidden or entirely scrolled-out dividers.
    if (end <= start || end <= railStart || start >= railEnd) continue
    if (coordinate < Math.max(railStart, start - DIVIDER_TOUCH_SNAP_PX)
      || coordinate > Math.min(railEnd, end + DIVIDER_TOUCH_SNAP_PX)) continue
    const side = coordinate < (start + end) / 2 ? 'before' : 'after'
    const half = child.querySelector<HTMLElement>(`[data-drawer-divider-drop*="divider-drop:${side}:"]`)
    if (!half?.dataset.drawerDividerDrop) continue
    const distance = Math.max(start - coordinate, coordinate - end, 0)
    if (!closest || distance < closest.distance) {
      closest = { id: half.dataset.drawerDividerDrop, side: 'inside', distance }
    }
  }
  return closest && { id: closest.id, side: closest.side }
}

/** Find the tab actually beneath the finger, not the dragged element above it. */
export function findDrawerMobilePointerTarget(
  rail: HTMLElement,
  draggedElement: HTMLElement,
  clientX: number,
  clientY: number,
  sourceRect?: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
): { id: string; side: DrawerSidebarDropSide } | null {
  const horizontal = isHorizontalRail(rail)
  const box = rail.getBoundingClientRect()
  if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return null

  // Prefer the divider's axis-aligned finger zone before elementFromPoint.
  // Otherwise a short mobile divider loses to its taller neighboring folder,
  // or to the rail itself, and the user can never insert before that divider.
  const dividerBoundary = findNearbyDividerBoundary(rail, clientX, clientY, horizontal)
  if (dividerBoundary) return dividerBoundary

  // The moving item receives elementFromPoint unless briefly excluded.
  const previous = draggedElement.style.pointerEvents
  draggedElement.style.pointerEvents = 'none'
  let hit: Element | null
  try {
    hit = rail.ownerDocument.elementFromPoint(clientX, clientY)
  } finally {
    draggedElement.style.pointerEvents = previous
  }
  if (!hit || !rail.contains(hit)) return null

  const edge = hit.closest<HTMLElement>('[data-drawer-edge-drop]')
  if (edge && rail.contains(edge)) {
    return { id: edge.dataset.drawerEdgeDrop!, side: 'inside' }
  }
  // A divider is a pair of precise root boundaries. Test it before the
  // nearest-tab fallback, or the trailing folder swallows the "before" side.
  const dividerHalf = hit.closest<HTMLElement>('[data-drawer-divider-drop]')
  if (dividerHalf && rail.contains(dividerHalf)) {
    return { id: dividerHalf.dataset.drawerDividerDrop!, side: 'inside' }
  }

  // Empty rail beyond the LAST root item belongs to root, not to the final
  // child of an expanded folder. Check the whole folder frame, not its header.
  // This also covers a browser returning the rail for a thin gap before the
  // root-end droppable, and works in either rail orientation.
  const endEdge = rail.querySelector<HTMLElement>('[data-drawer-edge-drop="drawer-layout:root-end"]')
  const lastRoot = Array.from(rail.children).reverse().find((child) =>
    child.hasAttribute('data-drawer-drag-id')
    || child.hasAttribute('data-drawer-folder-slot')
    || child.hasAttribute('data-drawer-divider')) as HTMLElement | undefined
  if (endEdge && lastRoot) {
    const lastRect = lastRoot === draggedElement && sourceRect
      ? sourceRect : lastRoot.getBoundingClientRect()
    const pastEnd = horizontal ? clientX > lastRect.right : clientY > lastRect.bottom
    if (pastEnd) return { id: endEdge.dataset.drawerEdgeDrop!, side: 'inside' }
  }

  let target = hit.closest<HTMLElement>('[data-drawer-drag-id]')
  const folderFrame = hit.closest<HTMLElement>('[data-drawer-folder-slot]')
  if ((!target || target === draggedElement) && folderFrame) {
    // Blank space WITHIN a folder's outline adds to that folder, even when
    // below/to the right of its header. Child icons remain distinct targets.
    target = folderFrame.querySelector<HTMLElement>('[data-drawer-drag-id]')
    if (target && target !== draggedElement) {
      return { id: target.dataset.drawerDragId!, side: 'inside' }
    }
  }
  if (target === draggedElement) return null
  if (target && rail.contains(target)) {
    return {
      id: target.dataset.drawerDragId!,
      side: drawerMobilePointerDropSide(clientX, target.getBoundingClientRect(), clientY, horizontal),
    }
  }

  // Don't turn a tiny wiggle inside the source's original footprint into a drop.
  if (sourceRect && clientX >= sourceRect.left && clientX <= sourceRect.right
    && clientY >= sourceRect.top && clientY <= sourceRect.bottom) return null

  // A finger between icons should resolve to the nearest insertion target too.
  const items = Array.from(rail.querySelectorAll<HTMLElement>('[data-drawer-drag-id]'))
    .filter((item) => item !== draggedElement && item.getBoundingClientRect().width > 0)
  if (!items.length) return null
  const distance = (item: HTMLElement) => {
    const r = item.getBoundingClientRect()
    return Math.abs((horizontal ? r.left + r.width / 2 : r.top + r.height / 2)
      - (horizontal ? clientX : clientY))
  }
  const nearest = items.reduce((best, item) => distance(item) < distance(best) ? item : best)
  return { id: nearest.dataset.drawerDragId!, side: drawerMobilePointerDropSide(clientX, nearest.getBoundingClientRect(), clientY, horizontal) }
}

export class DrawerMobilePointerDrag {
  private session: MobileSession | null = null

  start(event: DrawerMobilePointer, id: string, rail: HTMLElement | null, callbacks: DrawerMobileDragCallbacks) {
    if (!rail || this.session || !event.isPrimary || event.button !== 0) return
    const element = event.currentTarget
    // Keep quick taps targeted at the real button. Capturing on its wrapper
    // retargets the browser's click there too, bypassing folder expansion.
    const captureElement = element.querySelector<HTMLElement>('button') ?? element
    const session: MobileSession = {
      id, pointerId: event.pointerId, element, captureElement, rail,
      horizontal: isHorizontalRail(rail), startRect: element.getBoundingClientRect(),
      startScroll: (isHorizontalRail(rail) ? rail.scrollLeft : rail.scrollTop) ?? 0,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      started: false, holdTimer: null, scrollFrame: null, callbacks,
    }
    this.session = session
    captureElement.setPointerCapture?.(event.pointerId)
    session.holdTimer = setTimeout(() => this.lift(session), HOLD_TO_LIFT_MS)
  }

  move(event: DrawerMobilePointer) {
    const session = this.session
    if (!session || session.pointerId !== event.pointerId) return
    session.x = event.clientX
    session.y = event.clientY
    if (!session.started) {
      if (Math.hypot(session.x - session.startX, session.y - session.startY) < MOVE_THRESHOLD_PX) return
      this.lift(session)
    }
    event.preventDefault()
    this.paintAndHover(session)
  }

  end(event: DrawerMobilePointer) {
    const session = this.session
    if (!session || session.pointerId !== event.pointerId) return
    session.x = event.clientX
    session.y = event.clientY
    if (session.started) {
      event.preventDefault()
      const moved = Math.hypot(session.x - session.startX, session.y - session.startY) >= MOVE_THRESHOLD_PX
      const target = moved ? findDrawerMobilePointerTarget(session.rail, session.element, session.x, session.y, session.startRect) : null
      this.finish(session)
      session.callbacks.onDrop(session.id, target?.id ?? null, target?.side ?? 'inside')
    } else {
      this.finish(session)
    }
  }

  cancel(pointerId?: number) {
    const session = this.session
    if (!session || (pointerId !== undefined && session.pointerId !== pointerId)) return
    this.finish(session)
    if (session.started) session.callbacks.onCancel()
  }

  private lift(session: MobileSession) {
    if (this.session !== session || session.started) return
    if (session.holdTimer !== null) clearTimeout(session.holdTimer)
    session.holdTimer = null
    session.started = true
    session.callbacks.onStart(session.id)
    this.paintAndHover(session)
    this.keepScrolling(session)
  }

  private paintAndHover(session: MobileSession) {
    const rootStyle = session.element.ownerDocument.defaultView?.getComputedStyle(session.element.ownerDocument.documentElement)
    const scale = Number.parseFloat(rootStyle?.getPropertyValue('--lumiverse-ui-scale') ?? '') || 1
    // CSS `translate` is separate from the dnd-kit wrapper's `transform` style.
    // React re-renders while a hover target arms cannot erase this translation.
    const scrollDelta = ((session.horizontal ? session.rail.scrollLeft : session.rail.scrollTop) ?? 0) - session.startScroll
    // Compensate for rail auto-scroll so the grabbed icon stays beneath the finger.
    session.element.style.translate = `${(session.x - session.startX) / scale + (session.horizontal ? scrollDelta : 0)}px ${(session.y - session.startY) / scale + (session.horizontal ? 0 : scrollDelta)}px`
    const target = findDrawerMobilePointerTarget(session.rail, session.element, session.x, session.y, session.startRect)
    session.callbacks.onHover(session.id, target?.id ?? null, target?.side ?? 'inside')
  }

  private keepScrolling(session: MobileSession) {
    const view = session.rail.ownerDocument.defaultView
    if (!view?.requestAnimationFrame) return
    const tick = () => {
      if (this.session !== session || !session.started) return
      const rect = session.rail.getBoundingClientRect()
      const position = session.horizontal ? session.x - rect.left : session.y - rect.top
      const size = session.horizontal ? rect.width : rect.height
      const moved = Math.hypot(session.x - session.startX, session.y - session.startY) >= MOVE_THRESHOLD_PX
      const speed = !moved ? 0 : position < SCROLL_EDGE_PX ? -8 : position > size - SCROLL_EDGE_PX ? 8 : 0
      if (speed) {
        const before = session.horizontal ? session.rail.scrollLeft : session.rail.scrollTop
        if (session.horizontal) session.rail.scrollLeft += speed
        else session.rail.scrollTop += speed
        if ((session.horizontal ? session.rail.scrollLeft : session.rail.scrollTop) !== before) this.paintAndHover(session)
      }
      session.scrollFrame = view.requestAnimationFrame(tick)
    }
    session.scrollFrame = view.requestAnimationFrame(tick)
  }

  private finish(session: MobileSession) {
    if (this.session !== session) return
    this.session = null
    if (session.holdTimer !== null) clearTimeout(session.holdTimer)
    if (session.scrollFrame !== null) session.rail.ownerDocument.defaultView?.cancelAnimationFrame?.(session.scrollFrame)
    session.element.style.translate = ''
    if (session.captureElement.hasPointerCapture?.(session.pointerId)) session.captureElement.releasePointerCapture(session.pointerId)
  }
}
