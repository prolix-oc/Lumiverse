import { CSS, type Transform } from '@dnd-kit/utilities'
import { useCallback, useEffect, useRef } from 'react'

function getUiScale(): number {
  return (
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale'),
    ) || 1
  )
}

/**
 * Walk up from `node` to the nearest scrollable ancestor (the element that
 * auto-scrolls while a drag drags past the viewport edge). Returns null if the
 * node is not inside a scroll container.
 */
function getScrollableAncestor(node: Element | null): Element | null {
  let el = node?.parentElement ?? null
  while (el) {
    const { overflowY, overflowX } = getComputedStyle(el)
    const scrollableY = /(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight
    const scrollableX = /(auto|scroll|overlay)/.test(overflowX) && el.scrollWidth > el.clientWidth
    if (scrollableY || scrollableX) return el
    el = el.parentElement
  }
  return null
}

/**
 * Build a `translate3d` string from a `useSortable` transform, compensating for
 * the CSS `zoom: var(--lumiverse-ui-scale)` applied to `body > *` (see
 * theme/reset.css).
 *
 * dnd-kit's transform is the sum of two components measured in *different*
 * coordinate spaces under CSS `zoom`:
 *   - the pointer/rect delta, read from pointer events and getBoundingClientRect,
 *     which are viewport-relative and therefore in post-zoom (rendered) pixels;
 *   - the auto-scroll delta, read from `element.scrollTop`/`scrollLeft`, which is
 *     element-relative and therefore in pre-zoom (layout) pixels.
 *
 * A CSS transform on a zoomed element is itself applied in layout space (the
 * zoom multiplies it on paint), so only the pointer component must be divided by
 * the scale — the scroll component is already in layout pixels. Dividing the
 * whole sum (the previous behaviour) under-applied the scroll component by a
 * factor of the scale, so the card drifted further from the cursor the more the
 * list auto-scrolled. We subtract the scroll delta, scale the pointer remainder,
 * then add the scroll delta back untouched.
 */
function scaledTransform(
  transform: Transform | null,
  scrollDx: number,
  scrollDy: number,
): string | undefined {
  if (!transform) return CSS.Transform.toString(transform)
  const uiScale = getUiScale()
  if (uiScale === 1) return CSS.Transform.toString(transform)
  return CSS.Transform.toString({
    ...transform,
    x: (transform.x - scrollDx) / uiScale + scrollDx,
    y: (transform.y - scrollDy) / uiScale + scrollDy,
  })
}

interface ScaledSortableArgs {
  setNodeRef: (element: HTMLElement | null) => void
  transform: Transform | null
  transition?: string
  isDragging: boolean
}

/**
 * Wraps a `useSortable` result so the dragged row tracks the cursor correctly
 * regardless of UI scale or how far the list auto-scrolls. Returns a node ref to
 * spread onto the sortable element and the `style` (transform + transition).
 *
 * Falls back to the plain scaled transform when the row is not inside a scroll
 * container or scroll detection fails, so it can never behave worse than a naive
 * scale division.
 */
export function useScaledSortableStyle({
  setNodeRef,
  transform,
  transition,
  isDragging,
}: ScaledSortableArgs): {
  setNodeRef: (element: HTMLElement | null) => void
  style: { transform: string | undefined; transition: string | undefined }
} {
  const nodeRef = useRef<HTMLElement | null>(null)
  // Scroll container + its scroll offsets captured at drag start.
  const scrollStart = useRef<{ el: Element | null; top: number; left: number } | null>(null)

  const ref = useCallback(
    (element: HTMLElement | null) => {
      nodeRef.current = element
      setNodeRef(element)
    },
    [setNodeRef],
  )

  useEffect(() => {
    if (isDragging) {
      const el = getScrollableAncestor(nodeRef.current)
      scrollStart.current = { el, top: el?.scrollTop ?? 0, left: el?.scrollLeft ?? 0 }
    } else {
      scrollStart.current = null
    }
  }, [isDragging])

  let scrollDx = 0
  let scrollDy = 0
  const start = scrollStart.current
  if (isDragging && start?.el) {
    scrollDx = start.el.scrollLeft - start.left
    scrollDy = start.el.scrollTop - start.top
  }

  return {
    setNodeRef: ref,
    style: {
      transform: scaledTransform(transform, scrollDx, scrollDy),
      transition,
    },
  }
}
